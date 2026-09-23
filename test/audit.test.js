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
