const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'batch-qr-test-secret';
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
const code = 'LO / Đà Lạt #01?%';
const rows = [{ id: 66, batchCode: code }, { id: 67, batchCode: 'LO-001' }, { id: 68, batchCode: 'images' }, { id: 69, batchCode: 'expenses' }];
global.prisma = {
  user: { findUnique: async ({ where }) => ({ id: where.id, username: global.allRoles[where.id - 1], tokenver: 0, role: { name: global.allRoles[where.id - 1] } }) },
  cultivationBatch: { findUnique: async ({ where, select }) => {
    if (where.batchCode) assert.deepEqual(select, { id: true, batchCode: true });
    return rows.find((row) => where.batchCode ? row.batchCode === where.batchCode : row.id === where.id) || null;
  } }
};
require('./helpers/workflow.cjs').workflowModels(global.prisma);
const app = express();
app.use('/api/cultivation-batches', require('../routes/cultivationBatchManagement'));
let server;
let origin;
before(async () => { server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); }); origin = `http://127.0.0.1:${server.address().port}`; });
after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
const request = (value, role = 'staff') => fetch(`${origin}/api/cultivation-batches/by-code/${encodeURIComponent(value)}`, { headers: role ? { authorization: `Bearer ${jwt.sign({ id: global.allRoles.indexOf(role) + 1, username: role, tokenver: 0 }, process.env.JWT_SECRET)}` } : {} });

test('all roles resolve an exact encoded batch code, with surrounding whitespace trimmed', async () => {
  for (const role of global.allRoles) {
    const response = await request(` ${code} `, role);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id: 66, batchCode: code } });
  }
});
test('lookup validates length, requires authentication and does not match a code prefix', async () => {
  assert.equal((await request('')).status, 400);
  assert.equal((await request(' ')).status, 400);
  assert.equal((await request('x'.repeat(192))).status, 400);
  assert.equal((await request('LO')).status, 404);
  assert.equal((await request(code, null)).status, 401);
});

test('batch codes that match gallery or finance route names resolve before ID subrouters', async () => {
  for (const name of ['images', 'expenses']) {
    const response = await request(name);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, rows.find((row) => row.batchCode === name));
  }
});
