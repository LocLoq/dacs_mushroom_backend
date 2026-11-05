const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const express = require('express');
const { createPublicCache } = require('../services/publicCache');

class FakeRedis extends EventEmitter {
    constructor() { super(); this.status = 'ready'; this.data = new Map(); this.broken = false; }
    async get(key) { if (this.broken) throw Error('offline'); return this.data.get(key) || null; }
    async set(key, value, ...args) { if (this.broken) throw Error('offline'); if (args.includes('NX') && this.data.has(key)) return null; this.data.set(key, value); return 'OK'; }
    async del(key) { this.data.delete(key); }
    async eval(script, _count, ...args) {
        if (this.broken) throw Error('offline');
        if (script.includes("redis.call('SET'")) { const [epochKey, key, epoch, value] = args; if (this.data.get(epochKey) === epoch) this.data.set(key, value); }
        else { const [key, token] = args; if (this.data.get(key) === token) this.data.delete(key); }
    }
    disconnect() {}
}

test('public cache serves repeated reads, invalidates writes and bypasses credentials', async () => {
    const client = new FakeRedis(), cache = createPublicCache({ client, enabled: true, namespace: 'test' });
    const app = express(); let reads = 0;
    app.get('/item', cache.middleware({ group: 'species', ttl: 60, key: req => ({ page: req.query.page || '1' }) }), (_req, res) => res.json({ data: ++reads }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/item`;
    try {
        let response = await fetch(url); assert.equal(response.headers.get('x-cache'), 'MISS'); assert.equal((await response.json()).data, 1);
        await new Promise(resolve => setTimeout(resolve, 10));
        response = await fetch(url); assert.equal(response.headers.get('x-cache'), 'HIT'); assert.equal((await response.json()).data, 1);
        response = await fetch(url, { headers: { authorization: 'Bearer example' } }); assert.equal(response.headers.get('x-cache'), 'BYPASS'); assert.equal((await response.json()).data, 2);
        await cache.invalidate(['species']);
        response = await fetch(url); assert.equal(response.headers.get('x-cache'), 'MISS'); assert.equal((await response.json()).data, 3);
        client.broken = true;
        response = await fetch(url); assert.equal(response.headers.get('x-cache'), 'ERROR'); assert.equal((await response.json()).data, 4);
        await cache.invalidate(['species']); client.broken = false;
        response = await fetch(url); assert.equal(response.headers.get('x-cache'), 'MISS'); assert.equal((await response.json()).data, 5);
    } finally { cache.close(); await new Promise(resolve => server.close(resolve)); }
});

test('public writes invalidate only relevant cache groups after successful responses', async () => {
    const shared = require('../services/publicCache').publicCache(), old = shared.invalidate, calls = [];
    shared.invalidate = async groups => calls.push(groups);
    const app = express(); app.use('/api', require('../middlewares/cacheInvalidation').cacheInvalidation);
    app.post('/api/mushroom-species', (_req, res) => res.status(201).json({ data: 1 }));
    app.post('/api/cultivation-batches/1/growth-progress', (_req, res) => res.status(400).json({ code: 'invalid' }));
    app.post('/api/mushroom-classifier/classify', (_req, res) => res.status(202).json({ jobId: 'job' }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await fetch(`${base}/api/mushroom-species`, { method: 'POST' })).status, 201);
        assert.equal((await fetch(`${base}/api/cultivation-batches/1/growth-progress`, { method: 'POST' })).status, 400);
        assert.equal((await fetch(`${base}/api/mushroom-classifier/classify`, { method: 'POST' })).status, 202);
        assert.deepEqual(calls, [['species', 'gallery', 'progress']]);
    } finally { shared.invalidate = old; await new Promise(resolve => server.close(resolve)); }
});
