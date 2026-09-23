const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'report-history-secret'; global.privilegedRoles = ['admin', 'manager']; global.allRoles = ['admin', 'manager', 'staff'];
const lookup = { id: '11111111-1111-4111-8111-111111111111', status: 'SUCCEEDED', originalName: 'demo.jpg', predictedName: 'Nấm sò', edibility: 'NON_POISONOUS', confidence: 0.9, createdAt: new Date(), user: { id: 1, username: 'manager', full_name: 'Manager' } };
global.prisma = {
  user: { findUnique: async () => ({ tokenver: 0 }) },
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
