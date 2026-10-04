const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'dashboard-test-secret';
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
const users = [
    { id: 1, username: 'manager', full_name: 'Manager', email: 'manager@example.test', phone_number: '0901', tokenver: 0, role: { name: 'manager' } },
    { id: 2, username: 'staff', full_name: 'Staff', email: 'staff@example.test', phone_number: '0902', tokenver: 0, role: { name: 'staff' } }
];
const tasks = [];
const withRelations = (task) => ({ ...task, batch: task.batchId ? { batchCode: 'DEMO-001' } : null, assignee: users.find((user) => user.id === task.assigneeUserId) || null });
global.prisma = {
    $transaction: async (callback) => callback(global.prisma),
    user: {
        findUnique: async ({ where }) => users.find((user) => user.id === where.id || user.username === where.username) || null,
        count: async () => users.length,
        findMany: async () => users
    },
    cultivationBatch: { findUnique: async ({ where }) => where.id === 1 ? { id: 1, batchCode: 'DEMO-001' } : null },
    task: {
        count: async ({ where }) => tasks.filter((task) => !where.status || !where.status.in || where.status.in.includes(task.status)).length,
        findMany: async ({ where }) => tasks.filter((task) => !where.status || !where.status.in || where.status.in.includes(task.status)).map(withRelations),
        findUnique: async ({ where }) => { const task = tasks.find((item) => item.id === where.id); return task ? withRelations(task) : null; },
        create: async ({ data }) => { const task = { id: `00000000-0000-4000-8000-${String(tasks.length + 1).padStart(12, '0')}`, status: 'TODO', version: 0, createdAt: new Date(), updatedAt: new Date(), ...data }; tasks.push(task); return withRelations(task); },
        update: async ({ where, data }) => { const task = tasks.find((item) => item.id === where.id); Object.assign(task, data, { version: task.version + (data.version?.increment || 0), updatedAt: new Date() }); return withRelations(task); },
        delete: async ({ where }) => { const index = tasks.findIndex((item) => item.id === where.id); if (index < 0) throw new Error('missing'); return tasks.splice(index, 1)[0]; }
    }
};
const app = express();
app.use(express.json());
app.use('/api', require('../routes/login'));
app.use('/api/dashboard', require('../routes/dashboard'));
let server; let baseUrl;
const tokenFor = (user) => jwt.sign({ id: user.id, username: user.username, role: user.role.name, tokenver: 0 }, process.env.JWT_SECRET);
const request = (path, token, options = {}) => fetch(`${baseUrl}${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
before(async () => { server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); baseUrl = `http://127.0.0.1:${server.address().port}`; });
after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('auth me and dashboard task permissions follow the API contract', async () => {
    const managerToken = tokenFor(users[0]);
    const staffToken = tokenFor(users[1]);
    let response = await request('/api/auth/me', managerToken);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.role, 'manager');
    response = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'AUTH_INVALID_TOKEN');

    response = await request('/api/dashboard/tasks', managerToken, { method: 'POST', body: JSON.stringify({ title: '  Kiểm tra lô  ', batchId: 1, assigneeUserId: 2, dueAt: '2026-10-01T09:00:00.000Z' }) });
    assert.equal(response.status, 201);
    const task = (await response.json()).data;
    assert.equal(task.title, 'Kiểm tra lô');
    assert.equal(task.batchCode, 'DEMO-001');
    assert.equal(task.assignee.role, 'staff');

    response = await request('/api/dashboard/tasks', staffToken);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.length, 1);
    response = await request(`/api/dashboard/tasks/${task.id}`, staffToken, { method: 'PATCH', body: JSON.stringify({ status: 'IN_PROGRESS' }) });
    assert.equal(response.status, 200);
    response = await request(`/api/dashboard/tasks/${task.id}`, staffToken, { method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED' }) });
    assert.equal(response.status, 403);
    response = await request('/api/dashboard/task-assignees', managerToken);
    assert.equal(response.status, 200);
    response = await request(`/api/dashboard/tasks/${task.id}`, managerToken, { method: 'DELETE' });
    assert.equal(response.status, 200);
});

test('POST tasks accepts omitted, null and valid optional IDs', async (t) => {
    const managerToken = tokenFor(users[0]);
    for (const batchId of [undefined, null, 1]) {
        for (const assigneeUserId of [undefined, null, 2]) {
            await t.test(`batchId=${String(batchId)}, assigneeUserId=${String(assigneeUserId)}`, async () => {
                const response = await request('/api/dashboard/tasks', managerToken, {
                    method: 'POST',
                    body: JSON.stringify({ title: 'Công việc tùy chọn liên kết', batchId, assigneeUserId })
                });
                const body = await response.json();
                assert.equal(response.status, 201, JSON.stringify(body));
                assert.equal(body.data.batchId, batchId ?? null);
                assert.equal(body.data.assigneeUserId, assigneeUserId ?? null);
                assert.equal(body.data.batchCode, batchId ? 'DEMO-001' : null);
                assert.equal(body.data.assignee?.id ?? null, assigneeUserId ?? null);

                const detailResponse = await request(`/api/dashboard/tasks/${body.data.id}`, managerToken);
                assert.equal(detailResponse.status, 200);
                const detail = (await detailResponse.json()).data;
                assert.equal(detail.batchId, batchId ?? null);
                assert.equal(detail.assigneeUserId, assigneeUserId ?? null);
            });
        }
    }
});

test('POST tasks still rejects invalid and nonexistent optional IDs', async (t) => {
    const managerToken = tokenFor(users[0]);
    for (const field of ['batchId', 'assigneeUserId']) {
        for (const value of [0, -1, 1.5, '', '12kg', false, {}, 999]) {
            await t.test(`${field}=${JSON.stringify(value)}`, async () => {
                const taskCount = tasks.length;
                const response = await request('/api/dashboard/tasks', managerToken, {
                    method: 'POST',
                    body: JSON.stringify({ title: 'Liên kết không hợp lệ', batchId: null, assigneeUserId: null, [field]: value })
                });
                assert.equal(response.status, 400);
                assert.equal(tasks.length, taskCount);
            });
        }
    }
});
