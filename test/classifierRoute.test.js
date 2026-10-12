const assert = require('node:assert/strict');
const fs = require('fs');
const { after, before, test } = require('node:test');
const express = require('express');

const creates = [];
const queuedJobs = [];
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
global.prisma = {
    classifierLookup: {
        create: async ({ data }) => { creates.push(data); return { id: '22222222-2222-4222-8222-222222222222', status: 'QUEUED' }; },
        update: async () => ({}),
        count: async () => 0,
        findMany: async () => [],
        findUnique: async () => null
    },
    user: { findUnique: async () => ({ id: 1, username: 'user', tokenver: 0, role: { name: 'staff' } }) }
};

const queue = require('../queues/mushroomClassifierQueue');
queue.add = async (data, options) => queuedJobs.push({ data, options });
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
    await queue.close();
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
    t.mock.method(global.prisma.classifierLookup, 'update', async (args) => { failedLookup = args; return {}; });
    const form = new FormData();
    form.append('image', new Blob(['photo'], { type: 'image/png' }), 'queue-failure.png');
    const response = await fetch(`${baseUrl}/api/mushroom-classifier/classify`, { method: 'POST', body: form });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'INTERNAL_ERROR', message: 'Không thể tiếp nhận yêu cầu phân loại' });
    assert.equal(failedLookup.data.status, 'FAILED');
    assert.ok(failedLookup.data.completedAt instanceof Date);
    assert.equal(fs.existsSync(attemptedFile), false);
});
