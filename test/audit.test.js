const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');

const entries = [];
global.prisma = { auditLog: { create: async ({ data }) => entries.push(data) } };
const { auditAction, auditMiddleware } = require('../middlewares/audit');
const app = express();
app.use(express.json());
app.use('/api', auditMiddleware);
app.post('/api/example/:id', auditAction('EXAMPLE_UPDATE', { entityType: 'Example', entityId: (req) => req.params.id }), (req, res) => res.json({ ok: true }));
app.post('/api/credentials', auditAction('CREDENTIAL_TEST', { metadata: () => ({
    current_password: 'current-secret', newPassword: 'new-secret', password_hash: 'hash-secret',
    nested: { access_token: 'access-secret', refreshToken: 'refresh-secret', apiSecret: 'api-secret', label: 'safe' }
}) }), (req, res) => res.json({ ok: true }));
app.get('/api/ordinary', (req, res) => res.json({ ok: true }));
let server;
let baseUrl;

before(async () => {
    server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('audit middleware records important action without sensitive query values', async () => {
    entries.length = 0;
    const response = await fetch(`${baseUrl}/api/example/7?token=secret&search=nấm`, { method: 'POST' });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'EXAMPLE_UPDATE');
    assert.equal(entries[0].entityId, '7');
    assert.equal(entries[0].metadata.query.token, undefined);
    assert.equal(entries[0].metadata.query.search, 'nấm');
    assert.equal(entries[0].outcome, 'SUCCESS');
});

test('ordinary GET requests are not audited', async () => {
    entries.length = 0;
    await fetch(`${baseUrl}/api/ordinary`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(entries.length, 0);
});

test('audit redacts current/new passwords and credential variants from nested metadata and query', async () => {
    entries.length = 0;
    const response = await fetch(`${baseUrl}/api/credentials?new_password=query-secret&refresh_token=query-token&search=safe`, { method: 'POST' });
    assert.equal(response.status, 200);
    const entry = entries.find(item => item.action === 'CREDENTIAL_TEST');
    assert.ok(entry);
    assert.deepEqual(entry.metadata.nested, { label: 'safe' });
    assert.deepEqual(entry.metadata.query, { search: 'safe' });
    for (const secret of ['current-secret', 'new-secret', 'hash-secret', 'access-secret', 'refresh-secret', 'api-secret', 'query-secret', 'query-token']) assert.ok(!JSON.stringify(entry).includes(secret));
});
