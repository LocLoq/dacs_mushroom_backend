const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const Redis = require('ioredis');
const { createPublicCache } = require('../services/publicCache');
const redisUrl = process.env.CACHE_TEST_REDIS_URL;

test('real Redis coalesces misses and fences an old read across invalidation', { skip: !redisUrl }, async () => {
    const client = new Redis(redisUrl), second = new Redis(redisUrl);
    const namespace = `cache-test:${crypto.randomUUID()}`;
    const cache = createPublicCache({ enabled: true, client, namespace });
    const cache2 = createPublicCache({ enabled: true, client: second, namespace });
    const app = express(); let count = 0, version = 1;
    const handler = async (_req, res) => { const value = version; count++; await new Promise(resolve => setTimeout(resolve, 100)); res.json({ data: value }); };
    app.get('/first', cache.middleware({ group: 'species', ttl: 60, key: () => 'same' }), handler);
    app.get('/second', cache2.middleware({ group: 'species', ttl: 60, key: () => 'same' }), handler);
    app.get('/scheduled', cache.middleware({ group: 'progress', ttl: 15, key: () => 'scheduled' }), (_req, res) => { res.locals.cacheMaxSeconds = 1; res.json({ data: ++count }); });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(`${base}/${i % 2 ? 'first' : 'second'}`).then(r => r.json())));
        assert.equal(count, 1, 'one database read should populate concurrent misses');
        await cache.invalidate(['species']);
        const slow = fetch(`${base}/first`).then(r => r.json());
        await new Promise(resolve => setTimeout(resolve, 35));
        version = 2; await cache2.invalidate(['species']);
        const current = await fetch(`${base}/second`).then(r => r.json());
        await slow;
        assert.equal(current.data, 2);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal((await (await fetch(`${base}/first`)).json()).data, 2);
        const scheduled = await (await fetch(`${base}/scheduled`)).json();
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.notEqual((await (await fetch(`${base}/scheduled`)).json()).data, scheduled.data);
        let cursor = '0';
        do { const [next, keys] = await client.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 100); cursor = next; if (keys.length) await client.del(...keys); } while (cursor !== '0');
    } finally { cache.close(); cache2.close(); await new Promise(resolve => server.close(resolve)); }
});
