const fs = require('node:fs');
const crypto = require('node:crypto');
const { pushConfig } = require('../config/push');
function pushError(kind, code) { return Object.assign(new Error(code), { kind, code }); }
function firebaseError(error) {
    const invalid = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];
    const configuration = ['messaging/authentication-error', 'messaging/mismatched-credential', 'messaging/third-party-auth-error', 'messaging/invalid-apns-credentials', 'messaging/invalid-argument', 'app/invalid-credential', 'app/invalid-app-options', 'app/credential-error'];
    return pushError(invalid.includes(error.code) ? 'invalid' : configuration.includes(error.code) ? 'configuration' : 'temporary', error.code || 'fcm-unavailable');
}
function createFcmSender(send) {
    return async (device, payload) => {
        const data = { ...payload };
        if (data.origin == null) delete data.origin;
        try {
            await send({ token: device.token,
                notification: { title: 'Công việc', body: 'Có cập nhật công việc. Mở ứng dụng để xem.' },
                data: Object.fromEntries(Object.entries(data).map(([key,value]) => [key,String(value)])),
                android: { priority: 'high', ttl: 300000, notification: { tag: payload.notificationId } },
                apns: { headers: { 'apns-collapse-id': payload.notificationId, 'apns-push-type': 'alert', 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } }
            });
        } catch (error) { throw firebaseError(error); }
    };
}
function firebaseApp(env = process.env) {
    const { initializeApp, cert, applicationDefault, getApps } = require('firebase-admin/app');
    const file = env.GOOGLE_APPLICATION_CREDENTIALS || env.FIREBASE_SERVICE_ACCOUNT_FILE;
    let credential, projectId = env.FIREBASE_PROJECT_ID, fingerprint;
    if (file) {
        const contents = fs.readFileSync(file,'utf8');
        const account = JSON.parse(contents);
        if (!account.project_id || !account.client_email || !account.private_key) throw new Error('Invalid Firebase service account');
        projectId ||= account.project_id;
        if (projectId !== account.project_id) throw new Error('Firebase project mismatch');
        credential = cert(account);
        fingerprint = crypto.createHash('sha256').update(contents).digest('hex').slice(0,12);
    } else if (env.FIREBASE_USE_ADC === 'true' && projectId) {
        credential = applicationDefault(); fingerprint = projectId;
    } else throw new Error('Firebase credentials not configured');
    const name = `workflow-push-${fingerprint}`;
    return getApps().find(app => app.name === name) || initializeApp({ credential, projectId }, name);
}
function createProviderSenders(env = process.env, { silent = false } = {}) {
    if (env.PUSH_ENABLED !== 'true') return {};
    try {
        pushConfig(env);
        const app = firebaseApp(env);
        const { getMessaging } = require('firebase-admin/messaging');
        return { fcm: createFcmSender(message => getMessaging(app).send(message)) };
    } catch (_) { if (!silent) console.error('Firebase push credentials unavailable; in-app notifications remain available.'); return {}; }
}
function publicPushConfig(env = process.env) {
    const config = pushConfig(env);
    const senders = createProviderSenders(env, { silent: true });
    let projectId = config.projectId;
    const file = env.GOOGLE_APPLICATION_CREDENTIALS || env.FIREBASE_SERVICE_ACCOUNT_FILE;
    if (file) { try { projectId ||= JSON.parse(fs.readFileSync(file,'utf8')).project_id || null; } catch (_) {} }
    const channels = { fcm: !!senders.fcm };
    return { ...config, projectId, channels, version: crypto.createHash('sha256').update(JSON.stringify([config.version, projectId, channels])).digest('hex').slice(0,20) };
}
module.exports = { createFcmSender, firebaseError, createProviderSenders, publicPushConfig, pushError };
