const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { resolveRequestUser } = require('./auth');
const { positiveInteger } = require('../config/classifier.cjs');

function createRateLimiters(environment = process.env) {
    const windowMs = positiveInteger(environment, 'RATE_LIMIT_WINDOW_MS', 60000);
    const identify = async (req) => {
        let user;
        try { user = await resolveRequestUser(req); } catch (_) { /* Auth middleware still handles invalid tokens on protected routes. */ }
        return user ? `user:${user.id}` : `ip:${ipKeyGenerator(req.ip, 56)}`;
    };
    const options = {
        windowMs, standardHeaders: 'draft-8', legacyHeaders: false,
        keyGenerator: identify,
        handler: (req, res) => res.status(429).json({ code: 'RATE_LIMITED', message: 'Bạn đã gửi quá nhiều yêu cầu, vui lòng thử lại sau' }),
        skip: (req) => req.method === 'OPTIONS' || req.originalUrl.split('?')[0] === '/api/test'
    };
    return {
        api: rateLimit({ ...options, identifier: 'api', limit: positiveInteger(environment, 'API_RATE_LIMIT_MAX', 300) }),
        classifier: rateLimit({ ...options, identifier: 'classifier', limit: positiveInteger(environment, 'CLASSIFIER_RATE_LIMIT_MAX', 10) })
    };
}

function configureTrustProxy(app, environment = process.env) {
    const value = environment.TRUST_PROXY;
    if (!value || value === 'false' || value === '0') return app.set('trust proxy', false);
    if (value === 'true') throw new Error('TRUST_PROXY must specify trusted addresses/subnets or a hop count, not true');
    app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value.split(',').map((item) => item.trim()).filter(Boolean));
}

let shared;
const getRateLimiters = () => shared || (shared = createRateLimiters());
module.exports = { createRateLimiters, getRateLimiters, configureTrustProxy };
