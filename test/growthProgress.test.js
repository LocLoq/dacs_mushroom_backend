const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

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
        findUnique: async () => ({ tokenver: 0 })
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
            return { id: 3, ...args.data };
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
                updatedAt: new Date('2026-09-23T00:00:00.000Z')
            };
        }
    }
};

const router = require('../routes/cultivationBatchManagement');
const app = express();
app.use(express.json());
app.use('/api/cultivation-batches', router);

let server;
let baseUrl;

const managerToken = jwt.sign(
    { username: 'manager', role: 'manager', tokenver: 0 },
    process.env.JWT_SECRET
);
const staffToken = jwt.sign(
    { username: 'staff', role: 'staff', tokenver: 0 },
    process.env.JWT_SECRET
);

async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            authorization: `Bearer ${managerToken}`,
            ...(options.body ? { 'content-type': 'application/json' } : {}),
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
        data: { notes: 'Đã hình thành quả thể' }
    });
});

test('PATCH is restricted to admin and manager roles', async () => {
    const result = await request('/1/growth-progress/2', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${staffToken}` },
        body: JSON.stringify({ stage: 'FRUITING' })
    });

    assert.equal(result.status, 403);
    assert.equal(calls.update.length, 0);
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
