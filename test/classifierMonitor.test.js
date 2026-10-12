const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { test } = require('node:test');
const { lookupStore, inputFile } = require('./helpers/classifier.cjs');
const { classifierConfig } = require('../config/classifier.cjs');
const { createClassifierMonitor, cleanStaleClassifierFiles } = require('../services/classifierMonitor');
const { failLookup, removeInputFile } = require('../services/classifierLifecycle');

async function fixture(t, row, redis = false, job = null) {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    const inputPath = await inputFile();
    t.after(() => fs.promises.unlink(inputPath).catch(() => {}));
    const lookup = { id: 'lookup-1', inputPath, startedAt: null, updatedAt: new Date(0), queuedAt: new Date(0), ...row };
    const store = lookupStore([lookup]);
    const events = [], audits = [];
    const queue = { health: { check: async () => ({ redis, python: true }) }, getJob: async () => job };
    const monitor = createClassifierMonitor({ prisma: store.prisma, queue, now: () => 400000,
        fail: (args) => failLookup({ ...args, emit: (id, event) => events.push(event), audit: async (entry) => audits.push(entry) }) });
    return { ...store, inputPath, monitor, events, audits, queue };
}

test('queued lookup expires after five minutes even while Redis is disconnected', async (t) => {
    const f = await fixture(t, { status: 'QUEUED' });
    await f.monitor.run();
    assert.match(f.rows.get('lookup-1').errorMessage, /QUEUE_WAIT_TIMEOUT/);
    assert.equal(fs.existsSync(f.inputPath), false);
    await f.monitor.run();
    assert.deepEqual(f.events, ['failed']);
    assert.equal(f.audits.length, 1);
});

test('stuck PROCESSING lookup expires without waiting for Redis recovery', async (t) => {
    const f = await fixture(t, { status: 'PROCESSING', startedAt: new Date(200000) });
    await f.monitor.run();
    assert.match(f.rows.get('lookup-1').errorMessage, /PROCESSING_TIMEOUT/);
});

test('missing and failed Bull jobs reconcile after startup but preserve healthy retries', async (t) => {
    for (const [state, expected] of [[null, 'QUEUE_JOB_MISSING'], ['failed', 'QUEUE_JOB_FAILED'], ['delayed', null], ['waiting', null], ['active', null]]) {
        const job = state ? { getState: async () => state, remove: async () => {} } : null;
        const f = await fixture(t, { status: 'QUEUED', updatedAt: new Date(350000) }, true, job);
        await f.monitor.run();
        if (expected) assert.match(f.rows.get('lookup-1').errorMessage, new RegExp(expected));
        else { assert.equal(f.rows.get('lookup-1').status, 'QUEUED'); assert.ok(fs.existsSync(f.inputPath)); }
    }
    const fresh = await fixture(t, { status: 'QUEUED', updatedAt: new Date(399000) }, true);
    await fresh.monitor.run();
    assert.equal(fresh.rows.get('lookup-1').status, 'QUEUED');
});

test('monitor does not overlap runs, pages through records, or cancel a concurrently changed lookup', async (t) => {
    const f = await fixture(t, { status: 'QUEUED' });
    let release;
    t.mock.method(f.queue.health, 'check', () => new Promise((resolve) => { release = resolve; }));
    const first = f.monitor.run();
    assert.equal(f.monitor.run(), first);
    f.rows.get('lookup-1').updatedAt = new Date(399000);
    release({ redis: false, python: true });
    await first;
    assert.equal(f.rows.get('lookup-1').status, 'QUEUED');
    const store = lookupStore(['a', 'b', 'c'].map((id) => ({ id, status: 'QUEUED', startedAt: null, updatedAt: new Date(0) })));
    const seen = [];
    const monitor = createClassifierMonitor({ prisma: store.prisma, queue: { health: { check: async () => ({ redis: false }) } },
        config: { ...classifierConfig(), pageSize: 1 }, now: () => 400000, fail: async ({ lookup }) => { seen.push(lookup.id); return false; } });
    await monitor.run();
    assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('a failed event for a retrying attempt does not mark its lookup FAILED', async (t) => {
    const f = await fixture(t, { status: 'QUEUED', updatedAt: new Date(399000) });
    const worker = new EventEmitter();
    f.monitor.start(worker);
    const callback = worker.listeners('failed')[0];
    await callback({ id: 'lookup-1', data: { lookupId: 'lookup-1' }, getState: async () => 'delayed' });
    assert.equal(f.rows.get('lookup-1').status, 'QUEUED');
    await f.monitor.stop(worker);
});

test('cleanup refuses paths outside the classifier directory', async (t) => {
    t.mock.method(console, 'error', () => {});
    const outside = path.join(os.tmpdir(), `classifier-outside-${Date.now()}.png`);
    await fs.promises.writeFile(outside, 'outside');
    t.after(() => fs.promises.unlink(outside));
    await removeInputFile(outside);
    assert.equal(fs.existsSync(outside), true);
});

test('stale cleanup preserves images referenced by active jobs and defers unknown legacy ownership', async (t) => {
    t.mock.method(console, 'error', () => {});
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'classifier-cleanup-'));
    const active = path.join(directory, 'active.png');
    const orphan = path.join(directory, 'orphan.png');
    await Promise.all([active, orphan].map((file) => fs.promises.writeFile(file, 'image')));
    t.after(async () => {
        await Promise.all([active, orphan].map((file) => fs.promises.unlink(file).catch(() => {})));
        await fs.promises.rmdir(directory);
    });
    const cleanupOptions = { directory, removeFile: (file) => fs.promises.unlink(file) };
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await Promise.all([active, orphan].map((file) => fs.promises.utimes(file, past, past)));
    const store = lookupStore([{ id: 'active', status: 'QUEUED', inputPath: active }]);
    await cleanStaleClassifierFiles(store.prisma, cleanupOptions);
    assert.equal(fs.existsSync(active), true);
    assert.equal(fs.existsSync(orphan), false);
    const legacy = lookupStore([{ id: 'legacy', status: 'QUEUED', inputPath: null }]);
    await cleanStaleClassifierFiles(legacy.prisma, cleanupOptions);
    assert.equal(fs.existsSync(active), true);
});
