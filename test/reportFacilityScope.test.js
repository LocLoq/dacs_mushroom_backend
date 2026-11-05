const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'report-facility-test';
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
let query;
global.prisma = {
    user: { findUnique: async () => ({ id: 7, username: 'manager', tokenver: 0, role: { name: 'manager' } }) },
    facilityManager: { findUnique: async ({ where }) => where.facilityId_userId.facilityId === 1 ? { facilityId: 1, userId: 7 } : null },
    cultivationBatch: { count: async ({ where }) => { query = where; return 0; }, findMany: async () => [] }
};
const app = express(); app.use('/api/reports', require('../routes/reports'));
test('manager report queries are scoped and reject another facility', async () => {
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/reports/cultivation`;
    const headers = { authorization: `Bearer ${jwt.sign({ id: 7, username: 'manager', tokenver: 0 }, process.env.JWT_SECRET)}` };
    try {
        let response = await fetch(base, { headers }); assert.equal(response.status, 200);
        assert.deepEqual(query.facility, { managerAssignments: { some: { userId: 7 } } });
        response = await fetch(`${base}?facilityId=2`, { headers }); assert.equal(response.status, 403);
        response = await fetch(`${base}?facilityId=1`, { headers }); assert.equal(response.status, 200);
        assert.equal(query.facilityId, 1);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
