const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'batch-routes-secret';
global.allRoles = ['admin', 'manager', 'staff']; global.privilegedRoles = ['admin', 'manager'];
const batch = { id: 1, batchCode: 'DEMO-BATCH-001', status: 'FRUITING', facility: { id: 1, name: 'Trại demo' }, mushroom: { id: 1, commonName: 'Nấm sò' } };
global.prisma = {
    user: { findUnique: async () => ({ id: 1, username: 'manager', tokenver: 0, role: { name: 'manager' } }) },
    cultivationBatch: { count: async () => 1, findMany: async () => [batch], findUnique: async () => batch, create: async ({ data }) => ({ ...batch, ...data }), update: async ({ data }) => ({ ...batch, ...data }), delete: async () => batch },
    cultivationCareLog: { findMany: async () => [{ id: 1, batchId: 1 }], create: async ({ data }) => ({ id: 2, ...data }) },
    harvestRecord: { findMany: async () => [{ id: 1, totalYieldKg: 10 }], create: async ({ data }) => ({ id: 2, ...data }) },
    growthProgressRecord: { findMany: async () => [], create: async ({ data }) => ({ id: 1, ...data }), findFirst: async () => null, update: async () => null },
    $transaction: async (callback) => callback({ harvestRecord: { create: async ({ data }) => ({ id: 3, ...data }) }, cultivationBatch: { update: async () => batch } })
};
const app = express(); app.use(express.json()); app.use('/api/cultivation-batches', require('../routes/cultivationBatchManagement'));
let server; let baseUrl;
const token = jwt.sign({ id: 1, username: 'manager', role: 'manager', tokenver: 0 }, process.env.JWT_SECRET);
const request = (url, options = {}) => fetch(`${baseUrl}${url}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
before(async () => { server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); baseUrl = `http://127.0.0.1:${server.address().port}/api/cultivation-batches`; });
after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('cultivation batch, care-log and harvest endpoints have happy paths', async () => {
    let response = await request('/'); assert.equal(response.status, 200);
    response = await request('/1'); assert.equal(response.status, 200);
    response = await request('/', { method: 'POST', body: JSON.stringify({ batchCode: 'NEW-BATCH', facilityId: 1, mushroomId: 1, startDate: '2026-01-01' }) }); assert.equal(response.status, 201);
    response = await request('/1/care-logs'); assert.equal(response.status, 200);
    response = await request('/1/care-logs', { method: 'POST', body: JSON.stringify({ actionType: 'WATERING', notes: 'Đủ ẩm' }) }); assert.equal(response.status, 201);
    response = await request('/1/harvests'); assert.equal(response.status, 200);
    response = await request('/1/harvests', { method: 'POST', body: JSON.stringify({ totalYieldKg: 12.5, qualityGrade: 'A', finalizeBatch: true }) }); assert.equal(response.status, 201);
    response = await request('/1', { method: 'PUT', body: JSON.stringify({ status: 'HARVESTING' }) }); assert.equal(response.status, 200);
    response = await request('/1', { method: 'DELETE' }); assert.equal(response.status, 200);
});

test('batch and harvest routes reject malformed numeric values and dates', async () => {
    let response = await request('/', { method: 'POST', body: JSON.stringify({ batchCode: 'INVALID-BATCH', facilityId: 1, mushroomId: 1, startDate: 'not-a-date', bagQuantity: 1 }) });
    assert.equal(response.status, 400);
    response = await request('/1', { method: 'PUT', body: JSON.stringify({ bagQuantity: -1 }) });
    assert.equal(response.status, 400);
    response = await request('/1', { method: 'PUT', body: JSON.stringify({ defectRate: '12kg' }) });
    assert.equal(response.status, 400);
    response = await request('/1/harvests', { method: 'POST', body: JSON.stringify({ totalYieldKg: '12kg' }) });
    assert.equal(response.status, 400);
    response = await request('/1/harvests', { method: 'POST', body: JSON.stringify({ totalYieldKg: 1, harvestedAt: 'not-a-date' }) });
    assert.equal(response.status, 400);
});
