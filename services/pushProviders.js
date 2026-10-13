const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const webPush = require('web-push');
const { pushConfig, endpointUrl } = require('../config/push');

function pushError(kind, code) { return Object.assign(new Error(code), { kind, code }); }
function classifyHttp(status) {
    return status === 404 || status === 410 ? 'invalid' : status === 429 || status >= 500 ? 'temporary' : 'configuration';
}
function createUnifiedSender(env = process.env) {
    const config = pushConfig(env);
    return async (device, payload) => {
        let endpoint;
        try { endpoint = endpointUrl(device.token, config); } catch (_) { throw pushError('configuration', 'endpoint-origin-changed'); }
        let details;
        try {
            details = webPush.generateRequestDetails({ endpoint: endpoint.href, keys: { p256dh: device.p256dh, auth: device.auth } }, JSON.stringify(payload), {
                contentEncoding: 'aes128gcm', TTL: 300, urgency: 'high',
                vapidDetails: { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
            });
        } catch (_) { throw pushError('configuration', 'invalid-web-push-configuration'); }
        // web-push encrypts/signs; native request also supports explicitly configured HTTP LAN.
        // Native HTTP does not follow redirects. Preserve the distributor's endpoint/query.
        await new Promise((resolve, reject) => {
            const transport = endpoint.protocol === 'https:' ? https : http;
            const req = transport.request(endpoint, { method: 'POST', headers: { ...details.headers, 'X-UnifiedPush': '1', 'X-Tunnel-Skip-AntiPhishing-Page': 'true', Accept: 'application/json' }, timeout: 10000 }, res => {
                res.resume(); res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(pushError(classifyHttp(res.statusCode), `ntfy-${res.statusCode}`)));
            });
            req.on('timeout', () => req.destroy(pushError('temporary', 'ntfy-timeout')));
            req.on('error', reject); req.end(details.body);
        });
    };
}
function createApnsSender(env = process.env, connect = http2.connect) {
    const key = fs.readFileSync(env.APNS_KEY_FILE, 'utf8');
    const parsedKey = crypto.createPrivateKey(key);
    if (parsedKey.asymmetricKeyType !== 'ec' || parsedKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('APNs requires a P-256 key');
    let cached, signedAt = 0;
    return async (device, payload) => {
        const now = Math.floor(Date.now() / 1000);
        if (!cached || now - signedAt > 3000) {
            cached = jwt.sign({ iss: env.APNS_TEAM_ID, iat: now }, key, { algorithm: 'ES256', keyid: env.APNS_KEY_ID }); signedAt = now;
        }
        await new Promise((resolve, reject) => {
            const client = connect(device.apnsEnvironment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
            let finished = false;
            const finish = error => { if (finished) return; finished = true; clearTimeout(timer); client.destroy(); error ? reject(error) : resolve(); };
            const timer = setTimeout(() => finish(pushError('temporary', 'apns-timeout')), 10000);
            client.on('error', finish);
            const req = client.request({ ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${cached}`,
                'apns-topic': env.APNS_TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(now + 300),
                'apns-id': crypto.randomUUID(), 'apns-collapse-id': payload.notificationId });
            let status, body = '';
            req.on('response', headers => { status = headers[':status']; });
            req.setEncoding('utf8'); req.on('data', part => { if (body.length < 4096) body += part; });
            req.on('error', finish);
            req.on('end', () => {
                if (status === 200) return finish();
                let reason = {}; try { reason = JSON.parse(body); } catch (_) {}
                const invalid = reason.reason === 'Unregistered' || reason.reason === 'BadDeviceToken';
                const error = pushError(invalid ? 'invalid' : classifyHttp(status) === 'invalid' ? 'configuration' : classifyHttp(status), `apns-${reason.reason || status}`);
                error.invalidAt = reason.timestamp; finish(error);
            });
            req.end(JSON.stringify({ aps: { alert: { title: 'Công việc', body: 'Có cập nhật công việc. Mở ứng dụng để xem.' }, sound: 'default' }, ...payload }));
        });
    };
}
function createProviderSenders(env = process.env, { silent = false } = {}) {
    const config = pushConfig(env), senders = {};
    if (config.channels.unifiedpush) {
        try {
            webPush.getVapidHeaders(config.ntfyUrl, env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, "aes128gcm");
            const ec = crypto.createECDH('prime256v1'); ec.setPrivateKey(Buffer.from(env.VAPID_PRIVATE_KEY, 'base64url'));
            if (!ec.getPublicKey().equals(Buffer.from(env.VAPID_PUBLIC_KEY, 'base64url'))) throw new Error('VAPID pair mismatch');
            senders.unifiedpush = createUnifiedSender(env);
        }
        catch (_) { if (!silent) console.error('UnifiedPush configuration unavailable'); }
    }
    if (config.channels.apns) {
        try { senders.apns = createApnsSender(env); } catch (_) { if (!silent) console.error('APNs configuration unavailable'); }
    }
    return senders;
}
function publicPushConfig(env = process.env) {
    const config = pushConfig(env);
    const senders = createProviderSenders(env, { silent: true });
    const channels = { unifiedpush: !!senders.unifiedpush, apns: !!senders.apns };
    return { ...config, channels, version: crypto.createHash('sha256').update(JSON.stringify([config.version, channels])).digest('hex').slice(0,20) };
}
module.exports = { publicPushConfig, createProviderSenders, createUnifiedSender, createApnsSender, pushError, classifyHttp };
