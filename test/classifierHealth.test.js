const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classifierConfig } = require('../config/classifier.cjs');
const { createClassifierHealth, withDeadline } = require('../services/classifierHealth');

test('health probes cache only five seconds and preserve separate Redis/Python availability', async () => {
    let now = 0, calls = 0;
    const queue = { client: { status: 'ready', ping: async () => 'PONG' } };
    let healthy = true;
    const health = createClassifierHealth({ queue, now: () => now, get: async () => { calls++; return { status: healthy ? 200 : 503, data: { status: 'ready' } }; } });
    await health.assertReady();
    healthy = false;
    now = 4999;
    await health.assertReady();
    assert.equal(calls, 1);
    now = 5000;
    await assert.rejects(health.assertReady(), { code: 'CLASSIFIER_UNAVAILABLE', status: 503 });
    queue.client.status = 'reconnecting';
    await assert.rejects(health.assertReady(), { code: 'QUEUE_UNAVAILABLE' });
});

test('a Redis ping that never responds has a two-second deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const health = createClassifierHealth({ queue: { client: { status: 'ready', ping: () => new Promise(() => {}) } },
        get: async () => ({ status: 200, data: { status: 'ready' } }) });
    const pending = health.check();
    const assertion = pending.then((value) => { assert.equal(value.redis, false); assert.equal(value.python, true); });
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2000);
    await assertion;
});

test('enqueue deadline rejects without waiting for an eventual response', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finish;
    const pending = withDeadline(() => new Promise((resolve) => { finish = resolve; }), classifierConfig().enqueueTimeoutMs,
        Object.assign(new Error('timed out'), { code: 'QUEUE_UNAVAILABLE' }));
    const assertion = assert.rejects(pending, { code: 'QUEUE_UNAVAILABLE' });
    await Promise.resolve();
    t.mock.timers.tick(5000);
    await assertion;
    finish('late acknowledgement');
});

test('service health must report ready, not just HTTP success', async () => {
    const health = createClassifierHealth({ queue: { client: { status: 'ready', ping: async () => 'PONG' } },
        get: async () => ({ status: 200, data: { status: 'loading' } }) });
    await assert.rejects(health.assertReady(), { code: 'CLASSIFIER_UNAVAILABLE' });
});

test('an unresponsive Python health endpoint cannot hold admission open forever', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const health = createClassifierHealth({ queue: { client: { status: 'ready', ping: async () => 'PONG' } },
        get: () => new Promise(() => {}) });
    const assertion = assert.rejects(health.assertReady(), { code: 'CLASSIFIER_UNAVAILABLE' });
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2000);
    await assertion;
});
