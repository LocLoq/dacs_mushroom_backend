const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'report-history-secret'; global.privilegedRoles = ['admin', 'manager']; global.allRoles = ['admin', 'manager', 'staff'];
const lookup = { id: '11111111-1111-4111-8111-111111111111', status: 'SUCCEEDED', originalName: 'demo.jpg', predictedName: 'Nấm sò', edibility: 'NON_POISONOUS', confidence: 0.9, createdAt: new Date(), user: { id: 1, username: 'manager', full_name: 'Manager' } };
global.prisma = {
  user: { findUnique: async () => ({ id: 1, username: 'manager', tokenver: 0, role: { name: 'manager' } }) },
  productionFacility: { count: async () => 5 }, mushroom: { count: async () => 6 },
  cultivationBatch: { count: async () => 100, groupBy: async () => [], findMany: async () => [{ batchCode: 'DEMO-001', status: 'FRUITING', startDate: new Date(), expectedHarvestDate: null, endDate: null, defectRate: 2, facility: { name: 'Trại demo', province: 'Lâm Đồng' }, mushroom: { commonName: 'Nấm sò', scientificName: 'Demo' }, harvestRecords: [{ totalYieldKg: 12 }], growthRecords: [] }] },
  harvestRecord: { aggregate: async () => ({ _sum: { totalYieldKg: 12 } }), findMany: async () => [{ harvestedAt: new Date(), totalYieldKg: 12 }] },
  classifierLookup: { count: async () => 1, findMany: async () => [lookup], findUnique: async () => lookup },
  auditLog: { count: async () => 1, findMany: async () => [{ action: 'LOGIN', actorUsername: 'manager', actorRole: 'manager', outcome: 'SUCCESS', createdAt: new Date(), statusCode: 200 }] }
};
const queue = require('../queues/mushroomClassifierQueue'); queue.add = async () => undefined;
const app = express(); app.use(express.json()); app.use('/api', require('../routes/test')); app.use('/api/mushroom-classifier', require('../routes/mushroomClassifier')); app.use('/api/reports', require('../routes/reports'));
let server; let baseUrl; const token = jwt.sign({ id: 1, username: 'manager', role: 'manager', tokenver: 0 }, process.env.JWT_SECRET);
const request = (url) => fetch(`${baseUrl}${url}`, { headers: { authorization: `Bearer ${token}` } });
before(async () => { server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); baseUrl = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await queue.close(); });

test('health, classifier history and all report JSON endpoints have happy paths', async () => {
  let response = await fetch(`${baseUrl}/api/test`); assert.equal(response.status, 200);
  response = await request('/api/mushroom-classifier/history'); assert.equal(response.status, 200);
  response = await request(`/api/mushroom-classifier/history/${lookup.id}`); assert.equal(response.status, 200);
  for (const type of ['overview', 'cultivation', 'classifier', 'audit']) { response = await request(`/api/reports/${type}`); assert.equal(response.status, 200, type); }
});

test('reports and classifier history share strict filter and pagination validation', async (t) => {
  const batchReads = t.mock.method(global.prisma.cultivationBatch, 'findMany');
  const historyReads = t.mock.method(global.prisma.classifierLookup, 'findMany');
  for (const route of ['/api/reports/cultivation', '/api/mushroom-classifier/history']) {
    for (const query of ['page=1abc', 'limit=0', 'from=2026-02-30', 'from=2026-10-01T08:00:00', 'from=2026-10-02&to=2026-10-01']) {
      const response = await request(`${route}?${query}`);
      assert.equal(response.status, 400, `${route}?${query}`);
      assert.equal((await response.json()).code, 'INVALID_REQUEST');
    }
  }
  const tooLong = await request('/api/reports/cultivation?from=2020-01-01&to=2026-01-01');
  assert.equal(tooLong.status, 400);
  assert.equal(batchReads.mock.callCount(), 0);
  assert.equal(historyReads.mock.callCount(), 0);
});

test('report date-only boundaries use Vietnam time and retain 20/100 paging', async (t) => {
  const batchReads = t.mock.method(global.prisma.cultivationBatch, 'findMany');
  let response = await request('/api/reports/cultivation?from=2026-09-01&to=2026-09-02');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pagination.pageSize, 20);
  const where = batchReads.mock.calls[0].arguments[0].where;
  assert.equal(where.startDate.gte.toISOString(), '2026-08-31T17:00:00.000Z');
  assert.equal(where.startDate.lte.toISOString(), '2026-09-02T16:59:59.999Z');
  response = await request('/api/reports/cultivation?from=2026-09-01&to=2026-09-02&page=2&limit=200');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pagination.pageSize, 100);
  assert.equal(batchReads.mock.calls[1].arguments[0].skip, 100);
  response = await request('/api/mushroom-classifier/history');
  assert.equal((await response.json()).pagination.pageSize, 20);
});
