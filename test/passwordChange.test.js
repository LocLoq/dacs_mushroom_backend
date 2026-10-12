const assert = require('node:assert/strict');
const { before, after, beforeEach, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
process.env.JWT_SECRET = 'password-change-test-secret';
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
let users;
const apply = (user, data) => { for (const [key, value] of Object.entries(data)) user[key] = value && typeof value === 'object' && 'increment' in value ? user[key] + value.increment : value; };
const project = (user, select) => select ? Object.fromEntries(Object.keys(select).map(key => [key, user[key]])) : { ...user };
global.prisma = {
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
app.get('/api/public-example', require('../middlewares/auth').optionalAuthenticateToken, (req, res) => res.json({ data: req.user ? 'private' : 'public' }));
app.use('/api', require('../routes/login')); app.use('/api/admin', require('../routes/admin'));
let server, base;
const tokenFor = user => jwt.sign({ id: user.id, username: user.username, tokenver: user.tokenver }, process.env.JWT_SECRET);
const request = async (path, token, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
};
before(async () => { server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(async () => {
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
