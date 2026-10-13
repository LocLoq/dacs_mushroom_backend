const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const http = require('node:http');
const webPush = require('web-push');
const { createPushProcessor } = require('../queues/notificationQueue');
const { notifyUsers } = require('../services/notifications');
const { pushConfig, validateDevice, deviceIdentity } = require('../config/push');
const { createUnifiedSender, createProviderSenders } = require('../services/pushProviders');
function fixture() {
    const row = { id: 'delivery', attempts: 0, sentAt: null, cancelledAt: null, notification: { id: 'notice', userId: 1 }, device: { id: 'device', userId: 1, token: 'a'.repeat(64), provider: 'apns', active: true, registrationId: 'session', updatedAt: new Date(0) } };
    const writes = [];
    const prisma = {
        pushDelivery: { findUnique: async () => row, updateMany: async ({ where, data }) => { writes.push({ where, data }); if (!data.attempts) Object.assign(row, data); return { count: 1 }; } },
        pushDevice: { updateMany: async args => { writes.push(args); return { count: row.device.registrationId === args.where.registrationId ? 1 : 0 }; } }
    };
    prisma.$transaction = fn => fn(prisma);
    return { row, writes, prisma };
}
test('push success persists once and uses generic identity payload', async () => {
    const f = fixture(), sent = [];
    const process = createPushProcessor({ prisma: f.prisma, config: { apiUrl: 'https://api.example.test' }, senders: { apns: async (device, payload) => sent.push(payload) } });
    await process({ data: { deliveryId: 'delivery' } }); await process({ data: { deliveryId: 'delivery' } });
    assert.equal(sent.length, 1); assert.ok(f.row.sentAt);
    assert.deepEqual(sent[0], { notificationId: 'notice', userId: '1', registrationId: 'session', origin: 'https://api.example.test' });
});
test('temporary failure increments persisted attempts; configuration failure does not exhaust delivery', async () => {
    for (const kind of ['temporary', 'configuration']) {
        const f = fixture();
        const promise = createPushProcessor({ prisma: f.prisma, now: () => new Date(0), senders: { apns: async () => { throw { kind, code: 'failure' }; } } })({ data: { deliveryId: 'delivery' } });
        if (kind === 'temporary') await assert.rejects(promise); else await promise;
        assert.equal(f.writes[0].data.nextAttemptAt.getTime(), kind === 'temporary' ? 60000 : 300000);
        assert.deepEqual(f.writes[0].data.attempts, kind === 'temporary' ? { increment: 1 } : undefined);
    }
});
test('invalid registration is disabled and pending deliveries cancelled', async () => {
    const f = fixture();
    await createPushProcessor({ prisma: f.prisma, senders: { apns: async () => { throw { kind: 'invalid' }; } } })({ data: { deliveryId: 'delivery' } });
    assert.equal(f.writes[0].where.registrationId, 'session');
    assert.equal(f.writes[0].data.active, false); assert.ok(f.writes[1].data.cancelledAt);
});
test('late invalid endpoint response cannot disable a newer registration', async () => {
    const f = fixture();
    await createPushProcessor({ prisma: f.prisma, senders: { apns: async () => { f.row.device = { ...f.row.device, registrationId: 'new-session' }; throw { kind: 'invalid' }; } } })({ data: { deliveryId: 'delivery' } });
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].where.registrationId, 'session');
});
test('cancelled, exhausted, disabled, rebound and unconfigured deliveries are not sent', async () => {
    for (const change of [f => f.row.cancelledAt = new Date(), f => f.row.attempts = 5, f => f.row.device.active = false, f => f.row.device.userId = 2]) {
        const f = fixture(); change(f);
        await createPushProcessor({ prisma: f.prisma, senders: { apns: async () => assert.fail('must not send') } })({ data: { deliveryId: 'delivery' } });
    }
    const f = fixture(); await createPushProcessor({ prisma: f.prisma, senders: {} })({ data: { deliveryId: 'delivery' } }); assert.equal(f.writes.length, 0);
});
test('endpoint origin, host mode, keys and APNs environment are validated', () => {
    const ec = crypto.createECDH('prime256v1'); ec.generateKeys();
    const keys = { p256dh: ec.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
    const config = pushConfig({ PUSH_HOST_MODE: 'lan', NTFY_PUBLIC_URL: 'http://192.168.1.10:8081' });
    const data = { platform: 'android', provider: 'unifiedpush', token: 'http://192.168.1.10:8081/upABC?up=1', keys };
    assert.equal(validateDevice(data, config).identityHash.length, 64);
    for (const token of ['http://evil.test/upABC', 'http://192.168.1.10:8081/other', 'http://u:p@192.168.1.10:8081/upABC', 'http://192.168.1.10:8081/upABC#x']) assert.throws(() => validateDevice({ ...data, token }, config));
    assert.throws(() => validateDevice({ ...data, keys: { ...keys, auth: 'bad' } }, config));
    assert.throws(() => pushConfig({ NTFY_PUBLIC_URL: 'http://192.168.1.10:8081' }));
    assert.throws(() => pushConfig({ PUSH_HOST_MODE: 'lan', NTFY_PUBLIC_URL: 'http://public.example.test' }));
    assert.throws(() => validateDevice({ platform: 'ios', provider: 'apns', token: 'a'.repeat(64), apnsEnvironment: 'wrong' }));
    const ios = validateDevice({ platform: 'ios', provider: 'apns', token: 'A'.repeat(64), apnsEnvironment: 'sandbox' });
    assert.equal(ios.token, 'a'.repeat(64));
    assert.notEqual(deviceIdentity('apns', 'sandbox', ios.token), deviceIdentity('apns', 'production', ios.token));
    assert.notEqual(deviceIdentity('unifiedpush', null, 'upABC'), deviceIdentity('unifiedpush', null, 'upabc'));
});
test('configuration version changes on origin, key or channel changes', () => {
    const env = { PUSH_HOST_MODE: 'tunnel', API_PUBLIC_URL: 'https://api.devtunnels.ms', NTFY_PUBLIC_URL: 'https://push.devtunnels.ms', VAPID_PUBLIC_KEY: 'first' };
    const version = pushConfig(env).version;
    assert.notEqual(version, pushConfig({ ...env, VAPID_PUBLIC_KEY: 'second' }).version);
    assert.notEqual(version, pushConfig({ ...env, NTFY_PUBLIC_URL: 'https://new.devtunnels.ms' }).version);
    assert.deepEqual(createProviderSenders({}), {});
});
test('UnifiedPush encrypts HTTP LAN payload and refuses redirects', async () => {
    const ec = crypto.createECDH('prime256v1'); ec.generateKeys(); const vapid = webPush.generateVAPIDKeys();
    let redirected = false, encrypted;
    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/upRedirect')) { res.writeHead(302, { Location: '/upOther' }); res.end(); return; }
        if (req.url.startsWith('/upOther')) redirected = true;
        assert.equal(req.headers['content-encoding'], 'aes128gcm'); assert.match(req.headers.authorization, /^vapid /);
        const parts = []; req.on('data', part => parts.push(part)); req.on('end', () => { encrypted = Buffer.concat(parts); res.end('{}'); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const send = createUnifiedSender({ PUSH_HOST_MODE: 'lan', NTFY_PUBLIC_URL: origin, VAPID_SUBJECT: 'mailto:admin@example.test', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey });
        const device = { token: origin + '/upTest?up=1', p256dh: ec.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
        await send(device, { notificationId: 'notice' }); assert.ok(encrypted.length > 86); assert.equal(encrypted.includes(Buffer.from('notificationId')), false);
        await assert.rejects(send({ ...device, token: origin + '/upRedirect?up=1' }, {}), e => e.kind === 'configuration'); assert.equal(redirected, false);
    } finally { server.close(); }
});
test('notification recipients exclude actor/duplicates and only active devices receive outbox rows', async () => {
    const keys = new Map(), deliveries = new Map();
    const tx = { notification: { upsert: async ({ create }) => { const key = create.userId + ':' + create.eventKey; if (!keys.has(key)) keys.set(key, { id: key, ...create }); return keys.get(key); } },
        pushDevice: { findMany: async ({ where }) => { assert.equal(where.active, true); return [{ id: 'device' }]; } },
        pushDelivery: { upsert: async ({ create }) => deliveries.set(create.notificationId + ':' + create.deviceId, create) } };
    const input = { recipients: [1, 2, 2, null], actorId: 1, eventKey: 'same-event', type: 'TASK_CREATED', title: 'Assigned' };
    await notifyUsers(tx, input); await notifyUsers(tx, input); assert.equal(keys.size, 1); assert.equal(deliveries.size, 1);
});

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { createApnsSender } = require('../services/pushProviders');
test('APNs signs ES256, selects environment and classifies token/configuration/retry errors', async () => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mushroom-apns-test-'));
    const file = path.join(dir, 'key.p8'); fs.writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    let status = 200, reason = null, lastHeaders, lastOrigin, lastBody;
    const connect = origin => {
        lastOrigin = origin;
        const client = new EventEmitter(); client.destroy = () => {};
        client.request = headers => {
            lastHeaders = headers;
            const stream = new EventEmitter(); stream.setEncoding = () => {};
            stream.end = body => { lastBody = JSON.parse(body); queueMicrotask(() => { stream.emit('response', { ':status': status }); if (reason) stream.emit('data', JSON.stringify({ reason, timestamp: 1700000000000 })); stream.emit('end'); }); };
            return stream;
        }; return client;
    };
    try {
        const send = createApnsSender({ APNS_KEY_FILE: file, APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM123', APNS_TOPIC: 'com.example.thu' }, connect);
        const device = { token: 'a'.repeat(64), apnsEnvironment: 'sandbox' }, payload = { notificationId: crypto.randomUUID(), userId: '1' };
        await send(device, payload);
        assert.equal(lastOrigin, 'https://api.sandbox.push.apple.com'); assert.equal(lastHeaders['apns-push-type'], 'alert');
        const decoded = jwt.verify(lastHeaders.authorization.slice(7), pair.publicKey, { algorithms: ['ES256'] }); assert.equal(decoded.iss, 'TEAM123');
        assert.equal(lastBody.notificationId, payload.notificationId); assert.equal(lastHeaders['apns-collapse-id'], payload.notificationId);
        assert.equal(lastHeaders['apns-topic'], 'com.example.thu'); assert.equal(lastHeaders[':path'], '/3/device/' + device.token);
        await send({ ...device, apnsEnvironment: 'production' }, payload); assert.equal(lastOrigin, 'https://api.push.apple.com');
        for (const [code, text, kind] of [[410, 'Unregistered', 'invalid'], [400, 'BadDeviceToken', 'invalid'], [403, 'InvalidProviderToken', 'configuration'], [429, 'TooManyRequests', 'temporary'], [503, 'ServiceUnavailable', 'temporary']]) {
            status = code; reason = text; await assert.rejects(send(device, payload), error => error.kind === kind);
        }
        const vapid = webPush.generateVAPIDKeys();
        const senders = createProviderSenders({ PUSH_ENABLED: 'true', UNIFIEDPUSH_ENABLED: 'true', APNS_ENABLED: 'true', API_PUBLIC_URL: 'https://api.example.test', NTFY_PUBLIC_URL: 'https://push.example.test', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:admin@example.test', APNS_KEY_FILE: path.join(dir, 'missing.p8'), APNS_KEY_ID: 'KEY', APNS_TEAM_ID: 'TEAM', APNS_TOPIC: 'com.example.thu' });
        assert.equal(typeof senders.unifiedpush, 'function'); assert.equal(senders.apns, undefined);
    } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('a recovered Bull job cannot bypass the durable retry schedule', async () => {
    const f = fixture(); f.row.nextAttemptAt = new Date(60000);
    await createPushProcessor({ prisma: f.prisma, now: () => new Date(0), senders: { apns: async () => assert.fail('not due') } })({ data: { deliveryId: 'delivery' } });
    assert.equal(f.writes.length, 0);
});
