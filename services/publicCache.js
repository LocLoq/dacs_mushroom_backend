const crypto = require('crypto');
const Redis = require('ioredis');

// This cache is deliberately separate from the Redis instance used by Bull.
function createPublicCache({ client, enabled = process.env.CACHE_ENABLED === 'true', namespace = process.env.CACHE_NAMESPACE || 'mushroom:public:v1' } = {}) {
    const metrics = { hit: 0, miss: 0, bypass: 0, error: 0, invalidation: 0, coalesced: 0 };
    if (!enabled) return { enabled: false, middleware: () => (_req, res, next) => { metrics.bypass++; res.set('X-Cache', 'BYPASS'); next(); }, invalidate: async () => {}, metrics, close: () => {} };
    client ||= new Redis(process.env.CACHE_REDIS_URL || 'redis://127.0.0.1:6380', {
        lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 100, commandTimeout: 100
    });
    client.on('error', () => { metrics.error++; });
    if (client.status === 'wait') client.connect().catch(() => {});
    const inflight = new Map();
    let dirty = false;
    const groups = ['species', 'gallery', 'progress'];
    const epoch = async group => {
        if (dirty) { await Promise.all(groups.map(item => client.set(`${namespace}:epoch:${item}`, crypto.randomUUID()))); dirty = false; }
        const epochKey = `${namespace}:epoch:${group}`;
        let value = await client.get(epochKey);
        if (!value) { await client.set(epochKey, crypto.randomUUID(), 'NX'); value = await client.get(epochKey); }
        if (!value) throw Error('Cache epoch unavailable');
        return value;
    };
    async function invalidate(changed = groups) {
        try { await Promise.all((dirty ? groups : changed).map(group => client.set(`${namespace}:epoch:${group}`, crypto.randomUUID()))); dirty = false; metrics.invalidation++; }
        catch (_) { dirty = true; metrics.error++; }
    }
    const middleware = ({ group, ttl, key }) => async (req, res, next) => {
        if (req.user || req.headers.authorization) { metrics.bypass++; res.set('X-Cache', 'BYPASS'); return next(); }
        let identity;
        try { identity = key(req); } catch (error) { return next(error); }
        let generation, cacheKey, lockKey, lockToken;
        try {
            generation = await epoch(group);
            const digest = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
            cacheKey = `${namespace}:${generation}:${group}:${digest}`;
            let cached = await client.get(cacheKey);
            if (cached) { metrics.hit++; res.set('X-Cache', 'HIT'); return res.json(JSON.parse(cached)); }
            if (inflight.has(cacheKey)) {
                metrics.coalesced++;
                await Promise.race([inflight.get(cacheKey), new Promise(resolve => setTimeout(resolve, 250))]);
                cached = await client.get(cacheKey);
                if (cached) { metrics.hit++; res.set('X-Cache', 'HIT'); return res.json(JSON.parse(cached)); }
            }
            lockKey = `${cacheKey}:lock`;
            lockToken = crypto.randomUUID();
            if (!await client.set(lockKey, lockToken, 'PX', 3000, 'NX')) {
                metrics.coalesced++;
                for (let attempt = 0; attempt < 40; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    cached = await client.get(cacheKey);
                    if (cached) { metrics.hit++; res.set('X-Cache', 'HIT'); return res.json(JSON.parse(cached)); }
                }
                res.set('Retry-After', '1'); res.set('X-Cache', 'MISS');
                return res.status(503).json({ code: 'CACHE_BUSY', message: 'Dữ liệu đang được tải, vui lòng thử lại.' });
            }
            metrics.miss++; res.set('X-Cache', 'MISS');
        } catch (_) { metrics.error++; res.set('X-Cache', 'ERROR'); return next(); }
        let resolvePending;
        const pending = new Promise(resolve => { resolvePending = resolve; });
        if (!inflight.has(cacheKey)) inflight.set(cacheKey, pending);
        const original = res.json.bind(res);
        res.json = body => {
            if (res.statusCode === 200) {
                const seconds = Math.min(Math.floor(ttl * (0.9 + Math.random() * 0.1)), res.locals.cacheMaxSeconds ?? ttl);
                // Compare-and-set prevents a slow old read from repopulating an invalidated epoch.
                const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]) end return nil";
                (seconds > 0 ? client.eval(script, 2, `${namespace}:epoch:${group}`, cacheKey, generation, JSON.stringify(body), seconds) : Promise.resolve()).catch(() => { metrics.error++; }).finally(() => {
                    void client.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, lockKey, lockToken).catch(() => {});
                    if (inflight.get(cacheKey) === pending) inflight.delete(cacheKey);
                    resolvePending();
                });
            } else { void client.del(lockKey).catch(() => {}); if (inflight.get(cacheKey) === pending) inflight.delete(cacheKey); resolvePending(); }
            return original(body);
        };
        res.once('close', () => { if (inflight.get(cacheKey) === pending) inflight.delete(cacheKey); resolvePending(); });
        next();
    };
    return { enabled: true, middleware, invalidate, metrics, close: () => client.disconnect() };
}

let shared;
const publicCache = () => shared ||= createPublicCache();
module.exports = { createPublicCache, publicCache };
