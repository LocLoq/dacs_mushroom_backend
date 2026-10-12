const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { test } = require('node:test');

const enabled = process.env.RUN_CLASSIFIER_INTEGRATION === '1';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(check, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await delay(20); }
    throw new Error('Classifier integration condition timed out');
}

test('isolated Bull/Redis and Python recover from a service death mid-request and reconcile a lost job',
    { skip: !enabled, timeout: 30000 }, async (t) => {
        t.mock.method(console, 'error', () => {});
        t.mock.method(console, 'log', () => {});
        const { classifierConfig } = require('../config/classifier.cjs');
        const { createClassifierQueue } = require('../queues/mushroomClassifierQueue');
        const defaultQueue = require('../queues/mushroomClassifierQueue');
        t.after(() => defaultQueue.close());
        const { createMushroomClassifierProcessor } = require('../jobs/mushroom');
        const { createClassifierMonitor } = require('../services/classifierMonitor');
        const { createPythonSupervisor } = require('../services/pythonSupervisor');
        const { lookupStore, inputFile } = require('./helpers/classifier.cjs');
        const { failLookup } = require('../services/classifierLifecycle');

        const reservation = net.createServer();
        await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
        const port = reservation.address().port;
        await new Promise((resolve) => reservation.close(resolve));
        process.env.CLASSIFIER_SERVICE_URL = `http://127.0.0.1:${port}`;
        process.env.CLASSIFIER_TIMEOUT_MS = '10000';
        const interpreter = process.env.CLASSIFIER_TEST_PYTHON_BIN || (process.platform === 'win32'
            ? spawnSync('py', ['-3.12', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).stdout?.trim()
            : 'python3');
        assert.ok(interpreter, 'Python interpreter must be available');
        const config = { ...classifierConfig(), backoffMs: 250, restartBackoffMs: 20, healthTimeoutMs: 1000, missingGraceMs: 20 };
        const name = `classifier-test-${crypto.randomUUID()}`;
        assert.match(name, /^classifier-test-[0-9a-f-]+$/);
        const queue = createClassifierQueue({ redisUrl: process.env.CLASSIFIER_TEST_REDIS_URL || 'redis://127.0.0.1:6379/15', name, config });
        let worker;
        t.after(async () => {
            if (worker) await worker.close();
            // Only keys belonging to this randomly named test queue are removed.
            await queue.obliterate({ force: true });
            await queue.close();
        });
        let spawns = 0;
        let killedMidRequest = false;
        const supervisor = createPythonSupervisor({ config, log: () => {}, spawnChild: () => {
            const first = ++spawns === 1;
            const child = spawn(interpreter, [path.join(__dirname, 'fixtures', 'classifier_http.py')], {
                env: { ...process.env, TEST_CLASSIFIER_PORT: String(port), TEST_CLASSIFIER_DELAY: first ? '30' : '0' },
                stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
            });
            if (first) child.stdout.on('data', (chunk) => {
                if (!killedMidRequest && chunk.toString().includes('CLASSIFY_STARTED')) { killedMidRequest = true; child.kill('SIGTERM'); }
            });
            return child;
        }, waitReady: (signal) => waitUntil(async () => {
            if (signal.aborted) throw new Error('Service stopped');
            try { const response = await fetch(`${process.env.CLASSIFIER_SERVICE_URL}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(200)]) }); return response.ok; }
            catch (_) { return false; }
        }) });
        t.after(() => supervisor.stop());
        await supervisor.start();
        await waitUntil(() => queue.client.status === 'ready');
        await queue.health.assertReady();

        const store = lookupStore();
        const events = [], audits = [];
        const imagePath = await inputFile();
        t.after(() => fs.promises.unlink(imagePath).catch(() => {}));
        const lookup = await store.prisma.classifierLookup.create({ data: { inputPath: imagePath } });
        worker = queue.startWorker(createMushroomClassifierProcessor({ prisma: store.prisma, config,
            checkHealth: queue.health.pythonReady, emit: (id, event) => events.push(event), audit: async (entry) => audits.push(entry) }));
        await queue.add({ lookupId: lookup.id, path: imagePath, originalName: 'test.png', mimeType: 'image/png' }, { jobId: lookup.id });
        await waitUntil(() => store.rows.get(lookup.id).status === 'SUCCEEDED');
        await waitUntil(() => !fs.existsSync(imagePath));
        assert.equal(killedMidRequest, true);
        assert.ok(spawns >= 2);
        assert.ok(events.includes('retrying'));
        assert.equal(events.filter((event) => event === 'finished').length, 1);
        assert.equal(audits.filter((entry) => entry.action === 'CLASSIFIER_COMPLETED').length, 1);

        // Redis is healthy but a previously accepted job disappears before execution.
        await worker.pause(true);
        const lostImage = await inputFile();
        t.after(() => fs.promises.unlink(lostImage).catch(() => {}));
        const lost = await store.prisma.classifierLookup.create({ data: { inputPath: lostImage } });
        const job = await queue.add({ lookupId: lost.id, path: lostImage }, { jobId: lost.id });
        await job.remove();
        await delay(25);
        const monitor = createClassifierMonitor({ prisma: store.prisma, queue, config,
            fail: (args) => failLookup({ ...args, audit: async () => {}, emit: () => {} }) });
        await monitor.run();
        assert.match(store.rows.get(lost.id).errorMessage, /QUEUE_JOB_MISSING/);
        assert.equal(fs.existsSync(lostImage), false);

        // An accepted Redis job cannot stay queued forever after its connection fails.
        const strandedImage = await inputFile();
        t.after(() => fs.promises.unlink(strandedImage).catch(() => {}));
        const stranded = await store.prisma.classifierLookup.create({ data: { inputPath: strandedImage } });
        await queue.add({ lookupId: stranded.id, path: strandedImage }, { jobId: stranded.id });
        queue.client.disconnect();
        await delay(25);
        const offlineMonitor = createClassifierMonitor({ prisma: store.prisma, queue, config: { ...config, queueWaitMs: 20 },
            fail: (args) => failLookup({ ...args, audit: async () => {}, emit: () => {} }) });
        await offlineMonitor.run();
        assert.match(store.rows.get(stranded.id).errorMessage, /QUEUE_WAIT_TIMEOUT/);
        assert.equal(fs.existsSync(strandedImage), false);
        await queue.client.connect();
    });
