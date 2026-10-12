const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'management-routes-secret';
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
const admin = { id: 1, username: 'admin', password_hash: 'password', full_name: 'Admin', phone_number: '0900', email: 'admin@example.test', role_id: 1, tokenver: 0, role: { name: 'admin' } };
global.prisma = {
    user: {
        findUnique: async ({ where }) => where.username === 'new-user' ? null : { ...admin, id: where.id || admin.id, username: where.username || admin.username },
        count: async () => 1, findMany: async () => [admin], create: async ({ data }) => ({ id: 2, ...data }), update: async ({ data }) => ({ id: 1, ...data }), delete: async () => admin
    },
    role: { findMany: async () => [{ id: 1, name: 'admin' }] },
    auditLog: { count: async () => 1, findMany: async () => [{ id: 1, action: 'LOGIN', outcome: 'SUCCESS' }] },
    mushroom: { count: async () => 1, findMany: async () => [{ id: 1, commonName: 'Nấm sò' }], create: async ({ data }) => ({ id: 2, ...data }), update: async ({ data }) => ({ id: 1, ...data }), delete: async () => ({ id: 1 }) },
    productionFacility: {
        count: async () => 1, findMany: async () => [{ id: 1, name: 'Trại demo', mushrooms: [] }], findUnique: async () => ({ id: 1, name: 'Trại demo', mushrooms: [] }),
        create: async ({ data }) => ({ id: 2, ...data }), update: async ({ data }) => ({ id: 1, ...data }), delete: async () => ({ id: 1 })
    }
};

const app = express(); app.use(express.json());
app.use('/api', require('../routes/login'));
app.use('/api/admin', require('../routes/admin'));
app.use('/api/mushroom-species', require('../routes/mushroomSpeciesManagement'));
app.use('/api/production-facilities', require('../routes/productionFacilityManagement'));
let server; let baseUrl;
const token = jwt.sign({ id: 1, username: 'admin', role: 'admin', tokenver: 0 }, process.env.JWT_SECRET);
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const request = async (url, options = {}) => fetch(`${baseUrl}${url}`, { ...options, headers: { ...auth, ...options.headers } });

before(async () => { server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); baseUrl = `http://127.0.0.1:${server.address().port}`; });
after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('login, admin, mushroom and facility endpoints have authenticated happy paths', async () => {
    let response = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password' }) });
    assert.equal(response.status, 200);
    response = await request('/api/admin/audit-logs'); assert.equal(response.status, 200);
    response = await request('/api/admin/users'); assert.equal(response.status, 200);
    response = await request('/api/admin/roles'); assert.equal(response.status, 200);
    response = await request('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: 'new-user', password: 'password', full_name: 'New user', phone_number: '0901', email: 'new@example.test', role_id: 1 }) }); assert.equal(response.status, 201);
    response = await request('/api/admin/users/1', { method: 'PUT', body: JSON.stringify({ full_name: 'Updated', email: 'updated@example.test' }) }); assert.equal(response.status, 200);
    response = await request('/api/admin/users/1', { method: 'DELETE' }); assert.equal(response.status, 200);
    response = await request('/api/mushroom-species'); assert.equal(response.status, 200);
    response = await request('/api/mushroom-species', { method: 'POST', body: JSON.stringify({ scientificName: 'Demo species' }) }); assert.equal(response.status, 201);
    response = await request('/api/mushroom-species/1', { method: 'PUT', body: JSON.stringify({ commonName: 'Nấm mới' }) }); assert.equal(response.status, 200);
    response = await request('/api/mushroom-species/1', { method: 'DELETE' }); assert.equal(response.status, 200);
    response = await request('/api/production-facilities'); assert.equal(response.status, 200);
    response = await request('/api/production-facilities/1'); assert.equal(response.status, 200);
    response = await request('/api/production-facilities', { method: 'POST', body: JSON.stringify({ name: 'Trại mới', address: 'Đà Lạt', facilityType: 'HOUSEHOLD', mushrooms: [1] }) }); assert.equal(response.status, 201);
    response = await request('/api/production-facilities/1', { method: 'PUT', body: JSON.stringify({ name: 'Trại sửa', mushrooms: [1] }) }); assert.equal(response.status, 200);
    response = await request('/api/production-facilities/1', { method: 'DELETE' }); assert.equal(response.status, 200);
});

test('management APIs reject invalid IDs, pagination and bodies before writing', async (t) => {
    const writes = [
        t.mock.method(global.prisma.user, 'update'),
        t.mock.method(global.prisma.mushroom, 'create'),
        t.mock.method(global.prisma.productionFacility, 'create')
    ];
    const cases = [
        ['/api/admin/users/1abc', 'PUT', { full_name: 'Updated' }],
        ['/api/admin/users/1', 'PUT', { role_id: '1abc' }],
        ['/api/admin/users/1', 'PUT', []],
        ['/api/mushroom-species', 'POST', { scientificName: 'Demo', metadata: {} }],
        ['/api/mushroom-species', 'POST', { scientificName: [] }],
        ['/api/production-facilities', 'POST', { name: 'Demo', mushrooms: ['1abc'] }],
        ['/api/production-facilities', 'POST', { name: 'Demo', mushrooms: {} }],
        ['/api/production-facilities', 'POST', { name: 'Demo', totalAreaSqm: '12sqm' }]
    ];
    for (const [url, method, body] of cases) {
        const response = await request(url, { method, body: JSON.stringify(body) });
        assert.equal(response.status, 400, url);
        assert.equal((await response.json()).code, 'INVALID_REQUEST');
    }
    for (const url of ['/api/admin/users', '/api/admin/audit-logs', '/api/mushroom-species', '/api/production-facilities']) {
        for (const query of ['page=1abc', 'limit=0', 'page=9007199254740991']) {
            const response = await request(`${url}?${query}`);
            assert.equal(response.status, 400, `${url}?${query}`);
            assert.equal((await response.json()).code, 'INVALID_REQUEST');
        }
    }
    for (const write of writes) assert.equal(write.mock.callCount(), 0);
});

test('audit log default and blank filters return all actions with pagination', async (t) => {
    const count = t.mock.method(global.prisma.auditLog, 'count');
    const findMany = t.mock.method(global.prisma.auditLog, 'findMany');
    const filterNames = ['actorUserId', 'statusCode', 'action', 'entityType', 'entityId', 'outcome', 'from', 'to'];
    for (const blank of ['', '   ']) {
        const query = new URLSearchParams({ page: '2', limit: '20', ...Object.fromEntries(filterNames.map((name) => [name, blank])) });
        const response = await request(`/api/admin/audit-logs?${query}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.data, [{ id: 1, action: 'LOGIN', outcome: 'SUCCESS' }]);
        assert.equal(body.pagination.currentPage, 2);
        assert.equal(body.pagination.pageSize, 20);
        assert.deepEqual(count.mock.calls.at(-1).arguments[0], { where: {} });
        assert.deepEqual(findMany.mock.calls.at(-1).arguments[0], {
            where: {}, skip: 20, take: 20, orderBy: { createdAt: 'desc' }
        });
    }
});

test('audit log applies supplied filters and rejects malformed filters before querying logs', async (t) => {
    const count = t.mock.method(global.prisma.auditLog, 'count');
    const findMany = t.mock.method(global.prisma.auditLog, 'findMany');
    const query = new URLSearchParams({ actorUserId: '1', statusCode: '200', action: 'LOGIN', entityType: 'User', entityId: '1', outcome: 'SUCCESS', from: '2026-10-01', to: '2026-10-12' });
    let response = await request(`/api/admin/audit-logs?${query}`);
    assert.equal(response.status, 200);
    const where = {
        actorUserId: 1, statusCode: 200, action: 'LOGIN', entityType: 'User', entityId: '1', outcome: 'SUCCESS',
        createdAt: { gte: new Date('2026-10-01'), lte: new Date('2026-10-12') }
    };
    assert.deepEqual(count.mock.calls[0].arguments[0], { where });
    assert.deepEqual(findMany.mock.calls[0].arguments[0].where, where);
    count.mock.resetCalls();
    findMany.mock.resetCalls();
    for (const invalidQuery of [
        'actorUserId=abc', 'actorUserId=0', 'actorUserId=-1', 'actorUserId=1&actorUserId=2',
        'statusCode=abc', 'statusCode=0', 'statusCode=200&statusCode=400',
        'outcome=unknown', 'from=invalid', 'to=invalid', 'from=2026-10-12&to=2026-10-01'
    ]) {
        response = await request(`/api/admin/audit-logs?${invalidQuery}`);
        assert.equal(response.status, 400, invalidQuery);
        assert.equal((await response.json()).code, 'INVALID_REQUEST');
    }
    assert.equal(count.mock.callCount(), 0);
    assert.equal(findMany.mock.callCount(), 0);
});

test('Prisma uniqueness conflicts share a 409 response and login preserves password spaces', async (t) => {
    t.mock.method(global.prisma.mushroom, 'create', async () => { throw Object.assign(new Error('private SQL details'), { code: 'P2002' }); });
    let response = await request('/api/mushroom-species', { method: 'POST', body: JSON.stringify({ scientificName: 'Existing' }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'STATE_CONFLICT');

    const lookup = t.mock.method(global.prisma.user, 'findUnique', async () => ({ ...admin, password_hash: ' password ' }));
    response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: ' password ' }) });
    assert.equal(response.status, 200);
    lookup.mock.resetCalls();
    response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: [] }) });
    assert.equal(response.status, 400);
    assert.equal(lookup.mock.callCount(), 0);
    response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'password' }) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'INVALID_REQUEST');
});
