const assert = require('node:assert/strict');
const fs = require('fs');
const { after, before, test } = require('node:test');
const express = require('express');
const { lookupStore } = require('./helpers/classifier.cjs');
const { classifierConfig } = require('../config/classifier.cjs');

const creates = [];
const queuedJobs = [];
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
const store = lookupStore();
const create = store.prisma.classifierLookup.create;
store.prisma.classifierLookup.create = async ({ data }) => { creates.push(data); return create({ data }); };
global.prisma = {
    ...store.prisma,
    user: { findUnique: async () => ({ id: 1, username: 'user', tokenver: 0, role: { name: 'staff' } }) }
};

const queue = { add: async (data, options) => queuedJobs.push({ data, options }),
    health: { assertReady: async () => {} }, classifierConfig: classifierConfig() };
require.cache[require.resolve('../queues/mushroomClassifierQueue')] = { exports: queue };
const router = require('../routes/mushroomClassifier');
const app = express();
app.use('/api/mushroom-classifier', router);
let server;
let baseUrl;

before(async () => {
    server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await Promise.all(queuedJobs.map(({ data }) => fs.promises.unlink(data.path).catch(() => undefined)));
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('public classifier request creates a queued lookup and returns 202', async () => {
    creates.length = 0;
    queuedJobs.length = 0;
    const form = new FormData();
    form.append('image', new Blob(['classifier image'], { type: 'image/png' }), 'mushroom.png');
    const response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: form });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.status, 'QUEUED');
    assert.equal(creates[0].originalName, 'mushroom.png');
    assert.equal(queuedJobs[0].options.jobId, body.jobId);
    assert.equal(creates[0].inputPath, queuedJobs[0].data.path);
    assert.match(queuedJobs[0].data.path, /uploads[\\/]classifier[\\/]/);
});

test('classifier validation and upload errors return shared 400 errors without creating lookups', async () => {
    const initialCreates = creates.length;
    let response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: new FormData() });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_REQUEST');
    const form = new FormData();
    form.append('image', new Blob(['text'], { type: 'text/plain' }), 'invalid.txt');
    response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: form });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_REQUEST');
    assert.equal(creates.length, initialCreates);
});

test('classifier queue failures record FAILED, clean the image and retain status 503', async (t) => {
    let attemptedFile;
    let failedLookup;
    t.mock.method(console, 'error', () => {});
    t.mock.method(queue, 'add', async (data) => { attemptedFile = data.path; throw new Error('private Redis connection details'); });
    const update = global.prisma.classifierLookup.updateMany;
    t.mock.method(global.prisma.classifierLookup, 'updateMany', async (args) => { failedLookup = args; return update(args); });
    const form = new FormData();
    form.append('image', new Blob(['photo'], { type: 'image/png' }), 'queue-failure.png');
    const response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: form });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'QUEUE_UNAVAILABLE', message: 'Không thể tiếp nhận yêu cầu phân loại' });
    assert.equal(failedLookup.data.status, 'FAILED');
    assert.ok(failedLookup.data.completedAt instanceof Date);
    assert.equal(fs.existsSync(attemptedFile), false);
});

test('unhealthy dependencies reject before uploads or database creation', async (t) => {
    t.mock.method(console, 'error', () => {});
    const beforeCreates = creates.length;
    for (const code of ['CLASSIFIER_UNAVAILABLE', 'QUEUE_UNAVAILABLE']) {
        const mock = t.mock.method(queue.health, 'assertReady', async () => { throw Object.assign(new Error('unavailable'), { status: 503, code }); });
        const form = new FormData();
        form.append('image', new Blob(['photo'], { type: 'image/png' }), 'unavailable.png');
        const response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: form });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, code);
        mock.mock.restore();
    }
    assert.equal(creates.length, beforeCreates);
});

test('a hanging enqueue has a deadline and late enqueues cannot revive its failed lookup', async (t) => {
    t.mock.method(console, 'error', () => {});
    let finish;
    let data;
    const originalTimeout = queue.classifierConfig.enqueueTimeoutMs;
    queue.classifierConfig.enqueueTimeoutMs = 20;
    t.after(() => { queue.classifierConfig.enqueueTimeoutMs = originalTimeout; });
    t.mock.method(queue, 'add', async (args) => { data = args; return new Promise((resolve) => { finish = resolve; }); });
    const form = new FormData();
    form.append('image', new Blob(['photo'], { type: 'image/png' }), 'hanging.png');
    const response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: form });
    assert.equal(response.status, 503);
    assert.equal(store.rows.get(data.lookupId).status, 'FAILED');
    finish({ id: data.lookupId });
    const classify = t.mock.fn(async () => { throw new Error('must not run'); });
    const { createMushroomClassifierProcessor } = require('../jobs/mushroom');
    await createMushroomClassifierProcessor({ prisma: global.prisma, classify })({ data, discard() {} });
    assert.equal(classify.mock.callCount(), 0);
    assert.equal(fs.existsSync(data.path), false);
});

test('database outage while recording an enqueue failure retains the owned image for reconciliation', async (t) => {
    t.mock.method(console, 'error', () => {});
    let input;
    t.mock.method(queue, 'add', async (data) => { input = data; throw new Error('Redis down'); });
    t.mock.method(global.prisma.classifierLookup, 'updateMany', async () => { throw new Error('Database down'); });
    const form = new FormData();
    form.append('image', new Blob(['photo'], { type: 'image/png' }), 'persistence-outage.png');
    const response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: form });
    assert.equal(response.status, 503);
    assert.equal(store.rows.get(input.lookupId).status, 'QUEUED');
    assert.equal(fs.existsSync(input.path), true);
    t.after(() => fs.promises.unlink(input.path));
});

test('a failed initial database write cleans the image without leaving an owned lookup', async (t) => {
    t.mock.method(console, 'error', () => {});
    let inputPath;
    t.mock.method(global.prisma.classifierLookup, 'create', async ({ data }) => { inputPath = data.inputPath; throw new Error('Database down'); });
    const form = new FormData();
    form.append('image', new Blob(['photo'], { type: 'image/png' }), 'create-outage.png');
    const response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: form });
    assert.equal(response.status, 503);
    assert.equal(fs.existsSync(inputPath), false);
});

test('classifier rate limit returns 429 before uploading or checking dependencies', async (t) => {
    const health = t.mock.method(queue.health, 'assertReady');
    let response;
    for (let i = 0; i < 12; i++) {
        response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: new FormData() });
        if (response.status === 429) break;
    }
    assert.equal(response.status, 429);
    const calls = health.mock.callCount();
    const beforeCreates = creates.length;
    const form = new FormData();
    form.append('image', new Blob(['photo'], { type: 'image/png' }), 'limited.png');
    response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: form });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, 'RATE_LIMITED');
    assert.ok(response.headers.get('retry-after'));
    assert.ok(response.headers.get('ratelimit'));
    assert.equal(health.mock.callCount(), calls);
    assert.equal(creates.length, beforeCreates);
});
