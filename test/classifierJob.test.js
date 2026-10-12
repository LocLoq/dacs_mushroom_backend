const assert = require('node:assert/strict');
const fs = require('fs');
const { test } = require('node:test');
const { lookupStore, inputFile } = require('./helpers/classifier.cjs');
const { createMushroomClassifierProcessor } = require('../jobs/mushroom');
const { PythonClassifierError } = require('../services/pythonClassifierClient');
const { failLookup } = require('../services/classifierLifecycle');
const result = { name: 'Nấm demo', edibility: 'NON_POISONOUS', confidence: 0.98 };

async function fixture(t, classify) {
    t.mock.method(console, 'error', () => {});
    const inputPath = await inputFile();
    t.after(() => fs.promises.unlink(inputPath).catch(() => {}));
    const lookup = { id: '11111111-1111-4111-8111-111111111111', status: 'QUEUED', inputPath, startedAt: null, updatedAt: new Date() };
    const store = lookupStore([lookup]);
    const events = [], audits = [];
    const processor = createMushroomClassifierProcessor({ prisma: store.prisma, classify,
        audit: async (entry) => audits.push(entry), emit: (id, event, payload) => {
            if (event === 'finished') assert.equal(store.rows.get(id).status, 'SUCCEEDED');
            events.push({ event, payload });
        }
    });
    const job = { data: { lookupId: lookup.id, originalName: 'mushroom.png', mimeType: 'image/png', path: inputPath },
        opts: { attempts: 3 }, attemptsMade: 0, discarded: false, discard() { this.discarded = true; } };
    return { ...store, events, audits, processor, job, inputPath, lookup };
}

test('classifier worker persists success before broadcasting and removes the input image', async (t) => {
    const { processor, job, updates, events, audits, inputPath } = await fixture(t, async () => ({ result }));
    await processor(job);
    assert.equal(updates[0].data.status, 'PROCESSING');
    assert.equal(updates[1].data.status, 'SUCCEEDED');
    assert.equal(events.at(-1).event, 'finished');
    assert.equal(audits[0].action, 'CLASSIFIER_COMPLETED');
    await assert.rejects(fs.promises.access(inputPath));
});

test('transient failures preserve image, emit retrying with 30/60 seconds, and eventually succeed', async (t) => {
    let calls = 0;
    const f = await fixture(t, async () => { if (++calls < 3) throw new PythonClassifierError('SERVICE_UNAVAILABLE', 'down', true); return { result }; });
    for (let attempt = 0; attempt < 2; attempt++) {
        f.job.attemptsMade = attempt;
        await assert.rejects(f.processor(f.job));
        assert.equal(f.rows.get(f.lookup.id).status, 'QUEUED');
        assert.equal(f.rows.get(f.lookup.id).completedAt, null);
        assert.equal(f.events.at(-1).payload.retryDelayMs, 30000 * 2 ** attempt);
        assert.ok(fs.existsSync(f.inputPath));
        assert.equal(f.audits.length, 0);
    }
    f.job.attemptsMade = 2;
    await f.processor(f.job);
    assert.equal(calls, 3);
    assert.equal(f.rows.get(f.lookup.id).errorMessage, null);
    assert.equal(fs.existsSync(f.inputPath), false);
});

test('non-retryable errors and exhausted retries terminalize once and discard the job', async (t) => {
    for (const retryable of [false, true]) {
        const f = await fixture(t, async () => { throw new PythonClassifierError(retryable ? 'SERVICE_TIMEOUT' : 'IMAGE_INVALID', 'failure', retryable); });
        if (retryable) f.job.attemptsMade = 2;
        await assert.rejects(f.processor(f.job));
        assert.equal(f.rows.get(f.lookup.id).status, 'FAILED');
        assert.equal(f.job.discarded, true);
        assert.equal(fs.existsSync(f.inputPath), false);
        await f.processor(f.job);
        assert.equal(f.events.filter((e) => e.event === 'failed').length, 1);
        assert.equal(f.audits.filter((e) => e.action === 'CLASSIFIER_FAILED').length, 1);
    }
});

test('a late Python success cannot overwrite a watchdog failure and its request is aborted', async (t) => {
    let finish, signal;
    const f = await fixture(t, async (args) => { signal = args.signal; return new Promise((resolve) => { finish = resolve; }); });
    const pending = f.processor(f.job);
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    const current = structuredClone(f.rows.get(f.lookup.id));
    await failLookup({ prisma: f.prisma, lookup: current, code: 'PROCESSING_TIMEOUT', message: 'timeout', audit: async () => {}, emit: () => {} });
    assert.equal(signal.aborted, true);
    finish({ result });
    await pending;
    assert.equal(f.rows.get(f.lookup.id).status, 'FAILED');
    assert.equal(f.events.filter((e) => e.event === 'finished').length, 0);
});

test('a superseded stalled attempt cannot overwrite a newer successful attempt', async (t) => {
    let finish;
    let calls = 0;
    const f = await fixture(t, async () => ++calls === 1 ? new Promise((resolve) => { finish = resolve; }) : { result });
    const old = f.processor(f.job);
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    await f.processor({ ...f.job });
    finish({ result: { ...result, name: 'old result' } });
    await old;
    assert.equal(f.rows.get(f.lookup.id).predictedName, result.name);
    assert.equal(f.events.filter((e) => e.event === 'finished').length, 1);
});

test('completed replay skips Python and persistence failures retain the image for reconciliation', async (t) => {
    const f = await fixture(t, async () => ({ result }));
    await f.processor(f.job);
    const spy = t.mock.fn(async () => { throw new Error('must not run'); });
    const replay = createMushroomClassifierProcessor({ prisma: f.prisma, classify: spy });
    assert.deepEqual(await replay(f.job), { success: true, result });
    assert.equal(spy.mock.callCount(), 0);
    const g = await fixture(t, async () => { throw new PythonClassifierError('IMAGE_INVALID', 'bad'); });
    const original = g.prisma.classifierLookup.updateMany;
    t.mock.method(g.prisma.classifierLookup, 'updateMany', async (args) => {
        if (args.data.status !== 'PROCESSING') throw new Error('database down');
        return original(args);
    });
    await assert.rejects(g.processor(g.job));
    assert.equal(fs.existsSync(g.inputPath), true);
});
