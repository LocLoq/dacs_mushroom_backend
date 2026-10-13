const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const path = require('path');

process.env.JWT_SECRET = 'growth-progress-test-secret';

const calls = {
    create: [],
    findFirst: [],
    findMany: [],
    update: []
};

const state = {
    batch: { id: 1 },
    record: { id: 2, batchId: 1, stage: 'INCUBATION', notes: 'Đang ủ tơ' }
};

global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
global.prisma = {
    user: {
        findUnique: async () => ({ id: 1, username: 'manager', tokenver: 0, role: { name: 'manager' } })
    },
    cultivationBatch: {
        findUnique: async ({ where }) => (state.batch && where.id === state.batch.id ? state.batch : null)
    },
    growthProgressRecord: {
        findMany: async (args) => {
            calls.findMany.push(args);
            return [];
        },
        create: async (args) => {
            calls.create.push(args);
            return { id: 3, ...args.data, images: args.data.images?.create || [] };
        },
        findFirst: async (args) => {
            calls.findFirst.push(args);
            return state.record && args.where.id === state.record.id && args.where.batchId === state.record.batchId
                ? state.record
                : null;
        },
        update: async (args) => {
            calls.update.push(args);
            return {
                ...state.record,
                ...args.data,
                images: args.data.images?.create || [],
                updatedAt: new Date('2026-09-23T00:00:00.000Z')
            };
        }
    }
};

require('./helpers/workflow.cjs').workflowModels(global.prisma);
const router = require('../routes/cultivationBatchManagement');
const app = express();
app.use(express.json());
app.use('/api/cultivation-batches', router);

let server;
let baseUrl;

const managerToken = jwt.sign(
    { id: 1, username: 'manager', role: 'manager', tokenver: 0 },
    process.env.JWT_SECRET
);
async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            authorization: `Bearer ${managerToken}`,
            ...(typeof options.body === 'string' ? { 'content-type': 'application/json' } : {}),
            ...options.headers
        }
    });

    const responseText = await response.text();
    let body;
    try {
        body = JSON.parse(responseText);
    } catch {
        throw new Error(`Expected JSON response but received ${response.status}: ${responseText}`);
    }

    return { status: response.status, body };
}

before(async () => {
    server = await new Promise((resolve) => {
        const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/api/cultivation-batches`;
});

beforeEach(() => {
    state.batch = { id: 1 };
    state.record = { id: 2, batchId: 1, stage: 'INCUBATION', notes: 'Đang ủ tơ' };
    for (const callList of Object.values(calls)) callList.length = 0;
});

after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('POST creates a validated growth-progress record', async () => {
    const result = await request('/1/growth-progress', {
        method: 'POST',
        body: JSON.stringify({
            stage: '  FRUITING  ',
            notes: '  Đã xuất hiện quả thể  ',
            recordedAt: '2026-09-23T08:00:00.000Z'
        })
    });

    assert.equal(result.status, 201);
    assert.equal(result.body.data.stage, 'FRUITING');
    assert.equal(result.body.data.notes, 'Đã xuất hiện quả thể');
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].data.batchId, 1);
    assert.ok(calls.create[0].data.recordedAt instanceof Date);
});

test('POST rejects blank growth-progress fields', async () => {
    const result = await request('/1/growth-progress', {
        method: 'POST',
        body: JSON.stringify({ stage: '   ', notes: 'Ghi chú' })
    });

    assert.equal(result.status, 400);
    assert.equal(calls.create.length, 0);
});

test('GET validates batch ID and uses a deterministic ordering', async () => {
    const invalidResult = await request('/not-an-id/growth-progress');
    assert.equal(invalidResult.status, 400);

    const result = await request('/1/growth-progress');
    assert.equal(result.status, 200);
    assert.deepEqual(calls.findMany[0].orderBy, [{ recordedAt: 'desc' }, { id: 'desc' }]);
    assert.deepEqual(calls.findMany[0].include, { images: true });
});

test('PATCH updates only the specified progress record in its batch', async () => {
    const result = await request('/1/growth-progress/2', {
        method: 'PATCH',
        body: JSON.stringify({ notes: '  Đã hình thành quả thể  ' })
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.data.notes, 'Đã hình thành quả thể');
    assert.deepEqual(calls.findFirst[0].where, { id: 2, batchId: 1 });
    assert.deepEqual(calls.update[0], {
        where: { id: 2 },
        data: { notes: 'Đã hình thành quả thể', updatedByUserId: 1 },
        include: { images: true }
    });
});

test('PATCH appends actual photos to the growth-progress record', async () => {
    const form = new FormData();
    form.append('images', new Blob(['photo content'], { type: 'image/png' }), 'actual-photo.png');

    const result = await request('/1/growth-progress/2', {
        method: 'PATCH',
        body: form
    });

    try {
        assert.equal(result.status, 200);
        const image = calls.update[0].data.images.create[0];
        assert.match(image.imageUrl, /^\/uploads\/growth-progress\/[a-f0-9-]+\.png$/);
        assert.equal(image.originalName, 'actual-photo.png');
        assert.equal(image.mimeType, 'image/png');
        assert.equal(image.fileSize, 13);
    } finally {
        if (calls.update[0]) {
            const image = calls.update[0].data.images.create[0];
            await fs.promises.unlink(path.join(__dirname, '..', image.imageUrl.replace(/^\//, '')));
        }
    }
});

test('PATCH rejects invalid data and records outside the batch', async () => {
    const invalidBody = await request('/1/growth-progress/2', {
        method: 'PATCH',
        body: JSON.stringify({ batchId: 99 })
    });
    assert.equal(invalidBody.status, 400);
    assert.equal(calls.update.length, 0);

    state.record = { id: 2, batchId: 99, stage: 'INCUBATION', notes: 'Không thuộc lô này' };
    const wrongBatch = await request('/1/growth-progress/2', {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'FRUITING' })
    });
    assert.equal(wrongBatch.status, 404);
    assert.equal(calls.update.length, 0);
});

test('growth uploads are removed after validation and ownership failures', async () => {
    const directory = path.join(__dirname, '..', 'uploads', 'growth-progress');
    const originalFiles = new Set(await fs.promises.readdir(directory));
    for (const [url, values, status] of [
        ['/1/growth-progress', { stage: 'FRUITING', notes: 'Notes', recordedAt: '2026-02-30' }, 400],
        ['/1abc/growth-progress', { stage: 'FRUITING', notes: 'Notes' }, 400],
        ['/1/growth-progress/2', { metadata: '{}' }, 400],
        ['/99/growth-progress/2', {}, 404]
    ]) {
        const form = new FormData();
        form.append('images', new Blob(['photo'], { type: 'image/png' }), 'cleanup.png');
        for (const [key, value] of Object.entries(values)) form.append(key, value);
        const result = await request(url, { method: url.includes('/2') ? 'PATCH' : 'POST', body: form });
        assert.equal(result.status, status);
        assert.equal(result.body.code, 'INVALID_REQUEST');
        assert.deepEqual(new Set(await fs.promises.readdir(directory)), originalFiles);
    }
    assert.equal(calls.create.length, 0);
    assert.equal(calls.update.length, 0);
});

test('growth uploads are removed on database errors and multer errors share JSON responses', async (t) => {
    let imagePath;
    t.mock.method(global.prisma.growthProgressRecord, 'create', async ({ data }) => {
        imagePath = path.join(__dirname, '..', data.images.create[0].imageUrl.replace(/^\//, ''));
        throw new Error('private database connection details');
    });
    t.mock.method(console, 'error', () => {});
    const form = new FormData();
    form.append('images', new Blob(['photo'], { type: 'image/png' }), 'failure.png');
    form.append('stage', 'FRUITING');
    form.append('notes', 'Notes');
    const result = await request('/1/growth-progress', { method: 'POST', body: form });
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { code: 'INTERNAL_ERROR', message: 'Lỗi máy chủ' });
    assert.equal(fs.existsSync(imagePath), false);

    const invalidForm = new FormData();
    invalidForm.append('images', new Blob(['text'], { type: 'text/plain' }), 'invalid.txt');
    const invalidResult = await request('/1/growth-progress', { method: 'POST', body: invalidForm });
    assert.equal(invalidResult.status, 400);
    assert.equal(invalidResult.body.code, 'INVALID_REQUEST');

    const directory = path.join(__dirname, '..', 'uploads', 'growth-progress');
    const originalFiles = new Set(await fs.promises.readdir(directory));
    const tooMany = new FormData();
    for (let index = 0; index < 6; index++) tooMany.append('images', new Blob(['photo'], { type: 'image/png' }), `photo-${index}.png`);
    const limitResult = await request('/1/growth-progress', { method: 'POST', body: tooMany });
    assert.equal(limitResult.status, 400);
    assert.equal(limitResult.body.code, 'INVALID_REQUEST');
    assert.deepEqual(new Set(await fs.promises.readdir(directory)), originalFiles);
});
