const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const { createPushProcessor } = require('../queues/notificationQueue');
const { notifyUsers } = require('../services/notifications');
const { pushConfig, validateDevice, deviceIdentity } = require('../config/push');
const { createFcmSender, createProviderSenders, publicPushConfig } = require('../services/pushProviders');
function fixture() {
    const row = { id: 'delivery', attempts: 0, sentAt: null, cancelledAt: null, notification: { id: 'notice', userId: 1 }, device: { id: 'device', userId: 1, token: 'a'.repeat(64), provider: 'fcm', active: true, registrationId: 'session', updatedAt: new Date(0) } };
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
    const process = createPushProcessor({ prisma: f.prisma, config: { apiUrl: 'https://api.example.test' }, senders: { fcm: async (device, payload) => sent.push(payload) } });
    await process({ data: { deliveryId: 'delivery' } }); await process({ data: { deliveryId: 'delivery' } });
    assert.equal(sent.length, 1); assert.ok(f.row.sentAt);
    assert.deepEqual(sent[0], { notificationId: 'notice', userId: '1', registrationId: 'session', origin: 'https://api.example.test' });
});
test('temporary failure increments persisted attempts; configuration failure does not exhaust delivery', async () => {
    for (const kind of ['temporary', 'configuration']) {
        const f = fixture();
        const promise = createPushProcessor({ prisma: f.prisma, now: () => new Date(0), senders: { fcm: async () => { throw { kind, code: 'failure' }; } } })({ data: { deliveryId: 'delivery' } });
        if (kind === 'temporary') await assert.rejects(promise); else await promise;
        assert.equal(f.writes[0].data.nextAttemptAt.getTime(), kind === 'temporary' ? 60000 : 300000);
        assert.deepEqual(f.writes[0].data.attempts, kind === 'temporary' ? { increment: 1 } : undefined);
    }
});
test('invalid registration is disabled and pending deliveries cancelled', async () => {
    const f = fixture();
    await createPushProcessor({ prisma: f.prisma, senders: { fcm: async () => { throw { kind: 'invalid' }; } } })({ data: { deliveryId: 'delivery' } });
    assert.equal(f.writes[0].where.registrationId, 'session');
    assert.equal(f.writes[0].data.active, false); assert.ok(f.writes[1].data.cancelledAt);
});
test('late invalid endpoint response cannot disable a newer registration', async () => {
    const f = fixture();
    await createPushProcessor({ prisma: f.prisma, senders: { fcm: async () => { f.row.device = { ...f.row.device, registrationId: 'new-session' }; throw { kind: 'invalid' }; } } })({ data: { deliveryId: 'delivery' } });
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].where.registrationId, 'session');
});
test('cancelled, exhausted, disabled, rebound and unconfigured deliveries are not sent', async () => {
    for (const change of [f => f.row.cancelledAt = new Date(), f => f.row.attempts = 5, f => f.row.device.active = false, f => f.row.device.userId = 2]) {
        const f = fixture(); change(f);
        await createPushProcessor({ prisma: f.prisma, senders: { fcm: async () => assert.fail('must not send') } })({ data: { deliveryId: 'delivery' } });
    }
    const f = fixture(); await createPushProcessor({ prisma: f.prisma, senders: {} })({ data: { deliveryId: 'delivery' } }); assert.equal(f.writes.length, 0);
});
test('FCM registration validates provider/platform, opaque token and stable token identity', () => {
    const device = validateDevice({ platform:'android',token:'valid-token:ABC' });
    assert.equal(device.provider,'fcm'); assert.equal(device.identityHash.length,64);
    assert.equal(device.identityHash,validateDevice({platform:'ios',provider:'fcm',token:'valid-token:ABC'}).identityHash);
    assert.notEqual(device.identityHash,validateDevice({platform:'android',token:'valid-token:abc'}).identityHash);
    for (const body of [{platform:'web',token:'x'}, {platform:'android',provider:'unifiedpush',token:'x'}, {platform:'ios',provider:'apns',token:'x'}, {platform:'android',token:'https://old.example/upTest'}, {platform:'android',token:' '}, {platform:'android',token:'a'.repeat(4097)}, {platform:'ios',token:'x',apnsEnvironment:'sandbox'}]) assert.throws(()=>validateDevice(body));
});
test('Firebase configuration is disabled without credentials and keeps host mode validation', () => {
    assert.deepEqual(createProviderSenders({}),{});
    assert.equal(publicPushConfig({PUSH_ENABLED:'true',API_PUBLIC_URL:'https://api.example.test',GOOGLE_APPLICATION_CREDENTIALS:'missing.json'}).channels.fcm,false);
    assert.throws(()=>pushConfig({PUSH_HOST_MODE:'vps',API_PUBLIC_URL:'http://192.168.1.10:8080'}));
    assert.equal(pushConfig({PUSH_HOST_MODE:'lan',API_PUBLIC_URL:'http://192.168.1.10:8080'}).mode,'lan');
    assert.notEqual(pushConfig({API_PUBLIC_URL:'https://one.example.test'}).version,pushConfig({API_PUBLIC_URL:'https://two.example.test'}).version);
});
test('FCM sender builds generic notifications with identity data and collapse IDs for both platforms', async () => {
    const sent=[];const send=createFcmSender(async message=>sent.push(message));
    await send({token:'fcm-token',platform:'android'},{notificationId:'notice',userId:'1',registrationId:'session',origin:'https://api.example.test'});
    assert.equal(sent[0].token,'fcm-token');assert.equal(sent[0].android.notification.tag,'notice');assert.equal(sent[0].apns.headers['apns-collapse-id'],'notice');
    assert.deepEqual(sent[0].data,{notificationId:'notice',userId:'1',registrationId:'session',origin:'https://api.example.test'});
    assert.equal(sent[0].notification.body.includes('notice'),false);
});
test('FCM errors distinguish invalid token, configuration and temporary failures', async () => {
    for (const [code,kind] of [['messaging/registration-token-not-registered','invalid'],['messaging/invalid-registration-token','invalid'],['messaging/third-party-auth-error','configuration'],['messaging/mismatched-credential','configuration'],['messaging/invalid-argument','configuration'],['messaging/server-unavailable','temporary'],['messaging/quota-exceeded','temporary']]) {
        await assert.rejects(createFcmSender(async()=>{throw {code};})({token:'t'},{notificationId:'n'}),error=>error.kind===kind&&error.code===code);
    }
});
test('notification recipients exclude actor/duplicates and only active devices receive outbox rows', async () => {
    const keys = new Map(), deliveries = new Map();
    const tx = { notification: { upsert: async ({ create }) => { const key = create.userId + ':' + create.eventKey; if (!keys.has(key)) keys.set(key, { id: key, ...create }); return keys.get(key); } },
        pushDevice: { findMany: async ({ where }) => { assert.equal(where.active, true); return [{ id: 'device' }]; } },
        pushDelivery: { upsert: async ({ create }) => deliveries.set(create.notificationId + ':' + create.deviceId, create) } };
    const input = { recipients: [1, 2, 2, null], actorId: 1, eventKey: 'same-event', type: 'TASK_CREATED', title: 'Assigned' };
    await notifyUsers(tx, input); await notifyUsers(tx, input); assert.equal(keys.size, 1); assert.equal(deliveries.size, 1);
});

test('a recovered Bull job cannot bypass the durable retry schedule', async () => {
    const f = fixture(); f.row.nextAttemptAt = new Date(60000);
    await createPushProcessor({ prisma: f.prisma, now: () => new Date(0), senders: { fcm: async () => assert.fail('not due') } })({ data: { deliveryId: 'delivery' } });
    assert.equal(f.writes.length, 0);
});

test('push origin comes from the registered device, independently of API_PUBLIC_URL', async () => {
    const f = fixture(); f.row.device.serverOrigin = 'http://192.168.1.18:8080'; const sent=[];
    await createPushProcessor({prisma:f.prisma,config:{apiUrl:'http://192.168.1.12:8080'},senders:{fcm:async(device,payload)=>sent.push(payload)}})({data:{deliveryId:'delivery'}});
    assert.equal(sent[0].origin,'http://192.168.1.18:8080');
});
test('device origin accepts configured LAN/HTTPS origins and rejects credentials, paths and invalid protocols', () => {
    const body={platform:'android',token:'valid-token',serverOrigin:'http://192.168.1.18:8080'};
    assert.equal(validateDevice(body,{mode:'lan'}).serverOrigin,body.serverOrigin);
    assert.equal(validateDevice({...body,serverOrigin:'https://app-8080.eu.devtunnels.ms'},{mode:'vps'}).serverOrigin,'https://app-8080.eu.devtunnels.ms');
    for (const url of ['http://public.example.test','https://user:pass@example.test','https://example.test/api','https://example.test#fragment','file:///tmp/x']) assert.throws(()=>validateDevice({...body,serverOrigin:url},{mode:'lan'}));
    assert.throws(()=>validateDevice(body,{mode:'vps'}));
});
