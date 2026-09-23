const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');

const calls = [];
let batch;
global.prisma = {
    cultivationBatch: {
        findUnique: async (args) => {
            calls.push(args);
            return batch;
        }
    }
};

const router = require('../routes/publicGrowth');
const app = express();
app.use('/api/public', router);
let server;
let baseUrl;

before(async () => {
    server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    calls.length = 0;
    batch = {
        batchCode: 'LO-001', status: 'FRUITING', startDate: new Date('2026-01-01'), expectedHarvestDate: null,
        mushroom: { commonName: 'Nấm sò', scientificName: 'Pleurotus ostreatus', imageUrl: '/mushroom.jpg' },
        facility: { name: 'Trại A', province: 'Lâm Đồng' },
        growthRecords: [{ stage: 'Ra quả thể', notes: 'Đủ ẩm', recordedAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-02'), images: [{ imageUrl: '/uploads/growth-progress/a.jpg' }] }]
    };
});

after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('public growth endpoint returns only whitelisted current data without authentication', async () => {
    const response = await fetch(`${baseUrl}/api/public/cultivation-batches/LO-001/growth-progress/current`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.batchCode, 'LO-001');
    assert.equal(body.data.currentProgress.images[0].imageUrl, '/uploads/growth-progress/a.jpg');
    assert.equal('id' in body.data, false);
    assert.equal('address' in body.data.facility, false);
    assert.deepEqual(calls[0].select.growthRecords.orderBy, [{ recordedAt: 'desc' }, { id: 'desc' }]);
    assert.ok(calls[0].select.growthRecords.where.recordedAt.lte instanceof Date);
});

test('public growth returns null for a batch without progress and 404 for unknown batch', async () => {
    batch.growthRecords = [];
    let response = await fetch(`${baseUrl}/api/public/cultivation-batches/LO-001/growth-progress/current`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.currentProgress, null);

    batch = null;
    response = await fetch(`${baseUrl}/api/public/cultivation-batches/UNKNOWN/growth-progress/current`);
    assert.equal(response.status, 404);
});
