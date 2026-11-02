const assert = require('node:assert/strict');
const { before, after, beforeEach, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
process.env.JWT_SECRET = 'password-change-test-secret';
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
let users;
const auditEntries = [];
const apply = (user, data) => { for (const [key, value] of Object.entries(data)) user[key] = value && typeof value === 'object' && 'increment' in value ? user[key] + value.increment : value; };
const project = (user, select) => select ? Object.fromEntries(Object.keys(select).map(key => [key, user[key]])) : { ...user };
global.prisma = {
  auditLog: { create: async ({ data }) => { auditEntries.push(data); return data; } },
  user: {
    findUnique: async ({ where, select }) => { const user = users.find(u => where.id ? u.id === where.id : u.username === where.username); return user ? project(user, select) : null; },
    findMany: async ({ select }) => users.map(u => project(u, select)), count: async () => users.length,
    create: async ({ data, select }) => { const user = { id: users.length + 1, ...data, role: { name: 'staff' } }; users.push(user); return project(user, select); },
    update: async ({ where, data, select }) => { const user = users.find(u => u.id === where.id); apply(user, data); return project(user, select); },
    updateMany: async ({ where, data }) => { const user = users.find(u => u.id === where.id && u.tokenver === where.tokenver); if (!user) return { count: 0 }; apply(user, data); return { count: 1 }; }
  },
  role: { findMany: async () => [{ id: 1, name: 'admin' }, { id: 2, name: 'staff' }] },
  $transaction: async callback => callback(global.prisma)
};
const app = express(); app.use(express.json());
app.use('/api', require('../middlewares/audit').auditMiddleware);
app.get('/api/public-example', require('../middlewares/auth').optionalAuthenticateToken, (req, res) => res.json({ data: req.user ? 'private' : 'public' }));
app.use('/api', require('../routes/login')); app.use('/api/admin', require('../routes/admin'));
let server, base;
const tokenFor = user => jwt.sign({ id: user.id, username: user.username, tokenver: user.tokenver }, process.env.JWT_SECRET);
const request = async (path, token, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), requestId: response.headers.get('x-request-id') };
};
before(async () => { server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(async () => {
  auditEntries.length = 0;
  users = [
    { id: 1, username: 'admin', full_name: 'Admin', email: '', phone_number: '', role_id: 1, role: { name: 'admin' }, tokenver: 0, must_change_password: false, password_hash: await bcrypt.hash('admin-password', 4) },
    { id: 2, username: 'staff', full_name: 'Staff', email: '', phone_number: '', role_id: 2, role: { name: 'staff' }, tokenver: 0, must_change_password: false, password_hash: await bcrypt.hash(' old password ', 4) }
  ];
});
test('admin flag accepts only Boolean, is returned and survives unrelated edits', async () => {
  const adminToken = tokenFor(users[0]);
  let result = await request('/admin/users', adminToken, { username: 'new', password: 'temp', full_name: 'New', email: 'new@test', phone_number: '0900', role_id: 2, must_change_password: true });
  assert.equal(result.status, 201); assert.equal(result.body.data.must_change_password, true);
  result = await request('/admin/users/2', adminToken, { must_change_password: true }, 'PUT');
  assert.equal(result.status, 200); assert.equal(result.body.data.must_change_password, true);
  result = await request('/admin/users/2', adminToken, { full_name: 'Updated', role_id: 2 }, 'PUT');
  assert.equal(result.status, 200); assert.equal(result.body.data.must_change_password, true);
  for (const value of ['true', 1, null]) assert.equal((await request('/admin/users/2', adminToken, { must_change_password: value }, 'PUT')).status, 400);
  const list = await request('/admin/users', adminToken); assert.equal(list.body.data[1].must_change_password, true);
  result = await request('/admin/users/2', adminToken, { must_change_password: false }, 'PUT');
  assert.equal(result.body.data.must_change_password, false);
});
test('setting the flag blocks an existing token immediately while me and login remain available', async () => {
  const adminToken = tokenFor(users[0]);
  await request('/admin/users/1', adminToken, { must_change_password: true }, 'PUT');
  const blocked = await request('/admin/users', adminToken); assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
  const publicResult = await request('/public-example', adminToken); assert.equal(publicResult.status, 200); assert.equal(publicResult.body.data, 'public');
  const me = await request('/auth/me', adminToken); assert.equal(me.status, 200); assert.equal(me.body.data.must_change_password, true);
  const login = await request('/login', null, { username: 'admin', password: 'admin-password' }); assert.equal(login.status, 200);
});
test('self-service validates passwords, rotates token and preserves exact spaces', async () => {
  users[1].must_change_password = true; const oldToken = tokenFor(users[1]);
  for (const body of [{ current_password: 'bad', new_password: 'new' }, { current_password: ' old password ', new_password: ' old password ' }, { current_password: ' old password ', new_password: '' }]) {
    assert.equal((await request('/auth/change-password', oldToken, body)).status, 400); assert.equal(users[1].must_change_password, true);
  }
  const result = await request('/auth/change-password', oldToken, { current_password: ' old password ', new_password: ' new password ' });
  assert.equal(result.status, 200); assert.equal(result.body.data.must_change_password, false);
  assert.equal(await bcrypt.compare(' new password ', users[1].password_hash), true);
  assert.equal(users[1].tokenver, 1); assert.equal((await request('/auth/me', oldToken)).status, 401);
  assert.equal((await request('/auth/me', result.body.token)).status, 200);
  assert.equal((await request('/login', null, { username: 'staff', password: ' old password ' })).status, 401);
  assert.equal((await request('/login', null, { username: 'staff', password: ' new password ' })).status, 200);
});
test('a concurrent reset is not overwritten by self-service', async (t) => {
  const oldHash = users[1].password_hash;
  t.mock.method(global.prisma, '$transaction', async callback => { users[1].tokenver++; return callback(global.prisma); });
  const result = await request('/auth/change-password', tokenFor(users[1]), { current_password: ' old password ', new_password: 'new' });
  assert.equal(result.status, 409); assert.equal(users[1].password_hash, oldHash);
});

test('login audits successful, incorrect-password and unknown-account attempts without claiming failed identity', async (t) => {
  const terminal = t.mock.method(console, 'info', () => {});
  for (const [username, password, status] of [['staff', ' old password ', 200], ['staff', 'wrong-login-secret', 401], ['missing-account', 'unknown-login-secret', 401]]) {
    const response = await request('/login', null, { username, password });
    assert.equal(response.status, status);
    const entry = auditEntries.find(item => item.requestId === response.requestId);
    assert.ok(entry);
    assert.equal(entry.action, 'LOGIN');
    assert.equal(entry.entityType, 'User');
    assert.equal(entry.entityId, username === 'staff' ? '2' : null);
    assert.equal(entry.metadata.username, username);
    assert.equal(entry.actorUserId, status === 200 ? 2 : null);
    assert.equal(entry.outcome, status === 200 ? 'SUCCESS' : 'FAILURE');
    assert.ok(!JSON.stringify(entry).includes(password));
    assert.ok(!JSON.stringify(entry).includes(response.body.token || 'wrong-login-secret'));
  }
  assert.equal(terminal.mock.callCount(), 3);
  for (const call of terminal.mock.calls) {
    assert.equal(call.arguments[0], '[audit]');
    const entry = JSON.parse(call.arguments[1]);
    assert.equal(entry.action, 'LOGIN');
    assert.ok(!call.arguments[1].includes('password'));
  }
});

test('user creation audits the admin, created account ID, duplicate and forbidden requests', async (t) => {
  const terminal = t.mock.method(console, 'info', () => {});
  const body = { username: 'audit-account', password: 'create-account-secret', full_name: 'Audit account', email: 'audit@test', phone_number: '0900', role_id: 2 };
  for (const [actor, status] of [[users[0], 201], [users[0], 400], [users[1], 403]]) {
    const response = await request('/admin/users', tokenFor(actor), body);
    assert.equal(response.status, status);
    const entry = auditEntries.find(item => item.requestId === response.requestId);
    assert.equal(entry.action, 'USER_CREATE');
    assert.equal(entry.actorUserId, actor.id);
    assert.equal(entry.entityType, 'User');
    assert.equal(entry.entityId, status === 201 ? String(response.body.data.id) : null);
    assert.equal(entry.metadata.username, body.username);
    assert.equal(entry.outcome, status === 201 ? 'SUCCESS' : 'FAILURE');
    assert.ok(!JSON.stringify(entry).includes(body.password));
  }
  assert.equal(terminal.mock.callCount(), 3);
  assert.ok(!JSON.stringify(terminal.mock.calls).includes(body.password));
});

test('self-service and admin password reset have distinct audit actions with no password or token', async (t) => {
  const terminal = t.mock.method(console, 'info', () => {});
  const staffToken = tokenFor(users[1]);
  const adminToken = tokenFor(users[0]);
  const attempts = [
    ['/auth/change-password', staffToken, { current_password: 'incorrect-current-secret', new_password: 'new-password-secret' }, 'POST', 400, 'PASSWORD_CHANGE'],
    ['/auth/change-password', staffToken, { current_password: ' old password ', new_password: 'new-password-secret' }, 'POST', 200, 'PASSWORD_CHANGE'],
    ['/admin/users/2', adminToken, { password: 'admin-reset-secret' }, 'PUT', 200, 'PASSWORD_RESET'],
    ['/admin/users/2', adminToken, { password: '' }, 'PUT', 400, 'PASSWORD_RESET']
  ];
  for (const [path, token, body, method, status, action] of attempts) {
    const response = await request(path, token, body, method);
    assert.equal(response.status, status);
    const entry = auditEntries.find(item => item.requestId === response.requestId);
    assert.equal(entry.action, action);
    assert.equal(entry.entityId, '2');
    assert.equal(entry.actorUserId, action === 'PASSWORD_CHANGE' ? 2 : 1);
    assert.equal(entry.outcome, status === 200 ? 'SUCCESS' : 'FAILURE');
    const serialized = JSON.stringify(entry);
    for (const secret of [...Object.values(body).filter(Boolean), token, response.body.token].filter(Boolean)) assert.ok(!serialized.includes(secret));
  }
  const update = await request('/admin/users/2', adminToken, { full_name: 'Renamed' }, 'PUT');
  assert.equal(auditEntries.find(entry => entry.requestId === update.requestId).action, 'USER_UPDATE');
  assert.equal(terminal.mock.callCount(), attempts.length);
  for (const secret of ['incorrect-current-secret', 'new-password-secret', 'admin-reset-secret', staffToken, adminToken]) assert.ok(!JSON.stringify(terminal.mock.calls).includes(secret));
});
