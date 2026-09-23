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
        findUnique: async ({ where }) => where.username === 'new-user' ? null : { ...admin, username: where.username || admin.username },
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
