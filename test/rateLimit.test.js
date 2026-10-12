const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createRateLimiters, configureTrustProxy } = require('../middlewares/rateLimit');
const { optionalAuthenticateToken } = require('../middlewares/auth');

async function fixture(t, settings = {}) {
    global.allRoles = ['staff'];
    let userQueries = 0;
    process.env.JWT_SECRET = 'test-rate-limit-secret';
    global.prisma = { user: { findUnique: async ({ where }) => { userQueries++; return { id: where.id, username: `user${where.id}`, tokenver: 0, role: { name: 'staff' } }; } } };
    const app = express();
    const limits = createRateLimiters({ API_RATE_LIMIT_MAX: '3', CLASSIFIER_RATE_LIMIT_MAX: '2', ...settings });
    app.use('/api', limits.api);
    app.post('/api/classify', limits.classifier, optionalAuthenticateToken, (req, res) => res.json({ key: req.rateLimit.key }));
    app.get('/api/other', (req, res) => res.json({ key: req.rateLimit.key }));
    app.get('/api/test', (req, res) => res.json({ status: 'running' }));
    app.options('/api/other', (req, res) => res.sendStatus(204));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const token = (id, tokenver = 0) => jwt.sign({ id, username: `user${id}`, tokenver }, process.env.JWT_SECRET);
    const request = (route, id, method = 'GET', headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
        method, headers: { ...(id && { Authorization: `Bearer ${token(id)}` }), ...headers }
    });
    return { app, request, token, queries: () => userQueries };
}

test('general and classifier quotas are independent and return retry headers', async (t) => {
    const f = await fixture(t);
    assert.equal((await f.request('classify', null, 'POST')).status, 200);
    assert.equal((await f.request('classify', null, 'POST')).status, 200);
    const limited = await f.request('classify', null, 'POST');
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'RATE_LIMITED');
    assert.ok(limited.headers.get('retry-after'));
    assert.match(limited.headers.get('ratelimit'), /api|classifier/);
    assert.equal((await f.request('other')).status, 429);
    for (let i = 0; i < 4; i++) assert.equal((await f.request('test')).status, 200);
    assert.equal((await f.request('other', null, 'OPTIONS')).status, 204);
});

test('authenticated account identity is shared across middleware, with separate quotas per user', async (t) => {
    const f = await fixture(t);
    const first = await f.request('classify', 1, 'POST');
    assert.equal((await first.json()).key, 'user:1');
    assert.equal(f.queries(), 1);
    await f.request('classify', 1, 'POST');
    assert.equal((await f.request('classify', 1, 'POST')).status, 429);
    assert.equal((await f.request('classify', 2, 'POST')).status, 200);
    assert.equal((await f.request('classify', null, 'POST')).status, 200);
});

test('invalid/revoked JWTs cannot supply account quota and keep existing route authentication behavior', async (t) => {
    const f = await fixture(t);
    const revoked = { Authorization: `Bearer ${f.token(1, 99)}` };
    const first = await f.request('other', null, 'GET', revoked);
    assert.match((await first.json()).key, /^ip:/);
    const response = await f.request('classify', null, 'POST', revoked);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'AUTH_INVALID_TOKEN');
});

test('window expiry restores quota and untrusted forwarded IPs cannot evade limits', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 100000 });
    const f = await fixture(t, { API_RATE_LIMIT_MAX: '1' });
    assert.equal((await f.request('other', null, 'GET', { 'X-Forwarded-For': '203.0.113.1' })).status, 200);
    t.mock.method(console, 'error', () => {});
    assert.equal((await f.request('other', null, 'GET', { 'X-Forwarded-For': '203.0.113.2' })).status, 429);
    t.mock.timers.setTime(160001);
    assert.equal((await f.request('other')).status, 200);
});

test('IPv6 fallback aggregates the /56 subnet and proxy trust is explicit', async (t) => {
    const f = await fixture(t, { API_RATE_LIMIT_MAX: '1' });
    assert.equal(f.app.get('trust proxy'), false);
    configureTrustProxy(f.app, { TRUST_PROXY: 'loopback' });
    assert.equal((await f.request('other', null, 'GET', { 'X-Forwarded-For': '2001:db8:abcd:1200::1' })).status, 200);
    assert.equal((await f.request('other', null, 'GET', { 'X-Forwarded-For': '2001:db8:abcd:12ff::2' })).status, 429);
    assert.throws(() => configureTrustProxy(f.app, { TRUST_PROXY: 'true' }));
});
