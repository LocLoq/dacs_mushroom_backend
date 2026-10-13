const crypto = require('node:crypto');
const net = require('node:net');

function privateHost(host) {
    host = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') || (!host.includes('.') && !host.includes(':'))) return true;
    if (net.isIPv4(host)) {
        const [a, b] = host.split('.').map(Number);
        return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254;
    }
    return /^(fc|fd|fe[89ab])/i.test(host) && net.isIPv6(host);
}
function hostUrl(value, mode) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid public origin');
    if (url.protocol !== 'https:' && (mode !== 'lan' || !privateHost(url.hostname))) throw new Error('HTTP is allowed only for the configured LAN origin');
    return url.origin;
}
function pushConfig(env = process.env) {
    const mode = env.PUSH_HOST_MODE || 'vps';
    if (!['vps', 'lan', 'tunnel'].includes(mode)) throw new Error('Invalid PUSH_HOST_MODE');
    const ntfyUrl = env.NTFY_PUBLIC_URL ? hostUrl(env.NTFY_PUBLIC_URL, mode) : null;
    const apiUrl = env.API_PUBLIC_URL ? hostUrl(env.API_PUBLIC_URL, mode) : null;
    const enabled = env.PUSH_ENABLED === 'true';
    const unifiedpush = enabled && env.UNIFIEDPUSH_ENABLED === 'true' && !!(apiUrl && ntfyUrl && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
    const apns = enabled && env.APNS_ENABLED === 'true' && !!(apiUrl && env.APNS_KEY_FILE && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC);
    const version = crypto.createHash('sha256').update(JSON.stringify([mode, ntfyUrl, apiUrl, env.VAPID_PUBLIC_KEY, env.APNS_TOPIC, unifiedpush, apns])).digest('hex').slice(0, 20);
    return { mode, ntfyUrl, apiUrl, vapidPublicKey: env.VAPID_PUBLIC_KEY || null, channels: { unifiedpush, apns }, version };
}
function deviceIdentity(provider, environment, token) {
    return crypto.createHash('sha256').update(JSON.stringify([provider, environment || '', token])).digest('hex');
}
function endpointUrl(token, config = pushConfig()) {
    const url = new URL(token);
    if (!config.ntfyUrl || url.origin !== config.ntfyUrl || url.username || url.password || url.hash || !/^\/up[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('Endpoint must belong to the configured ntfy origin and up topic');
    return url;
}
function validateDevice(body, config = pushConfig()) {
    const { platform, provider, apnsEnvironment } = body;
    let token = body.token;
    if (typeof token !== 'string' || !token.length || token !== token.trim() || token.length > 8192) throw new Error('Invalid token');
    const data = { platform, provider, token, p256dh: null, auth: null, apnsEnvironment: null };
    if (platform === 'android' && provider === 'unifiedpush') {
        endpointUrl(token, config);
        const keys = body.keys;
        if (!keys || Object.keys(keys).some(k => !['p256dh', 'auth'].includes(k)) || !/^[\w-]{87}$/.test(keys.p256dh || '') || !/^[\w-]{22}$/.test(keys.auth || '')) throw new Error('Invalid Web Push keys');
        const publicKey = Buffer.from(keys.p256dh, 'base64url');
        if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('Invalid P-256 public key');
        // Reject invalid points before accepting an encrypted registration.
        crypto.ECDH.convertKey(publicKey, 'prime256v1');
        Object.assign(data, keys);
        if (apnsEnvironment !== undefined) throw new Error('Unexpected APNs environment');
    } else if (platform === 'ios' && provider === 'apns') {
        if (!/^[a-fA-F0-9]{64}$/.test(token) || !['sandbox', 'production'].includes(apnsEnvironment) || body.keys !== undefined) throw new Error('Invalid APNs registration');
        data.token = token.toLowerCase(); data.apnsEnvironment = apnsEnvironment;
    } else throw new Error('Invalid platform/provider');
    return { ...data, identityHash: deviceIdentity(provider, data.apnsEnvironment, data.token) };
}
module.exports = { pushConfig, hostUrl, privateHost, deviceIdentity, endpointUrl, validateDevice };
