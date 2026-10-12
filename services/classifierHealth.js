const axios = require('axios');
const { classifierConfig } = require('../config/classifier.cjs');

function unavailable(code, message) {
    return Object.assign(new Error(message), { status: 503, code, retryable: true });
}

// Always observe the underlying promise, including a rejection after the deadline.
async function withDeadline(operation, milliseconds, error) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => { timer = setTimeout(() => reject(error), milliseconds); })
        ]);
    } finally { clearTimeout(timer); }
}

function createClassifierHealth({ queue, config = classifierConfig(), now = Date.now, get = axios.get } = {}) {
    let cached;
    let pending;
    const baseUrl = (process.env.CLASSIFIER_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
    const queueReady = async () => {
        if (queue.client.status !== 'ready') throw unavailable('QUEUE_UNAVAILABLE', 'Hàng đợi nhận diện chưa sẵn sàng');
        const reply = await withDeadline(() => queue.client.ping(), config.healthTimeoutMs,
            unavailable('QUEUE_UNAVAILABLE', 'Hàng đợi nhận diện không phản hồi'));
        if (reply !== 'PONG') throw unavailable('QUEUE_UNAVAILABLE', 'Hàng đợi nhận diện chưa sẵn sàng');
    };
    const pythonReady = async () => {
        try {
            const response = await withDeadline(() => get(`${baseUrl}/health`, {
                timeout: config.healthTimeoutMs, signal: AbortSignal.timeout(config.healthTimeoutMs)
            }), config.healthTimeoutMs, unavailable('CLASSIFIER_UNAVAILABLE', 'Python classifier không phản hồi'));
            if (response.status !== 200 || response.data?.status !== 'ready') throw new Error('Not ready');
        } catch (_) {
            throw unavailable('CLASSIFIER_UNAVAILABLE', 'Dịch vụ nhận diện nấm chưa sẵn sàng');
        }
    };
    const check = async (force = false) => {
        if (!force && cached && now() - cached.at < config.healthCacheMs) return cached;
        if (pending) return pending;
        pending = (async () => {
            const [redis, python] = await Promise.allSettled([queueReady(), pythonReady()]);
            cached = { at: now(), redis: redis.status === 'fulfilled', python: python.status === 'fulfilled' };
            return cached;
        })().finally(() => { pending = null; });
        return pending;
    };
    const assertReady = async () => {
        const health = await check();
        if (!health.redis || queue.client.status !== 'ready') throw unavailable('QUEUE_UNAVAILABLE', 'Hàng đợi nhận diện chưa sẵn sàng');
        if (!health.python) throw unavailable('CLASSIFIER_UNAVAILABLE', 'Dịch vụ nhận diện nấm chưa sẵn sàng');
    };
    return { check, assertReady, pythonReady };
}

module.exports = { createClassifierHealth, withDeadline, unavailable };
