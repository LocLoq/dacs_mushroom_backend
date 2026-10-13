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
    const apiUrl = env.API_PUBLIC_URL ? hostUrl(env.API_PUBLIC_URL, mode) : null;
    const enabled = env.PUSH_ENABLED === 'true';
    const version = crypto.createHash('sha256').update(JSON.stringify([mode, apiUrl, 'fcm', env.FIREBASE_PROJECT_ID || null, enabled])).digest('hex').slice(0,20);
    return { mode, apiUrl, provider: 'fcm', projectId: env.FIREBASE_PROJECT_ID || null, channels: { fcm: enabled }, version };
}
function deviceIdentity(provider, environment, token) {
    return crypto.createHash('sha256').update(JSON.stringify([provider, environment || '', token])).digest('hex');
}
function validateDevice(body, config = pushConfig()) {
    const { platform, token } = body;
    const provider = body.provider || 'fcm';
    if (!['android','ios'].includes(platform) || provider !== 'fcm') throw new Error('Invalid platform/provider');
    if (typeof token !== 'string' || !token.length || token.length > 4096 || token !== token.trim() || /[\s\x00-\x1f\x7f]/.test(token) || /^https?:\/\//i.test(token)) throw new Error('Invalid FCM token');
    if (body.keys !== undefined || body.apnsEnvironment !== undefined) throw new Error('FCM registration does not accept UnifiedPush/APNs keys');
    let serverOrigin = null;
    if (body.serverOrigin !== undefined) {
        if (typeof body.serverOrigin !== 'string' || body.serverOrigin.length > 512) throw new Error('Invalid serverOrigin');
        serverOrigin = hostUrl(body.serverOrigin, config.mode);
        if (serverOrigin.length > 512) throw new Error('Invalid serverOrigin');
    }
    return { platform, provider, token, serverOrigin, p256dh: null, auth: null, apnsEnvironment: null, identityHash: deviceIdentity(provider,null,token) };
}
module.exports = { pushConfig, hostUrl, privateHost, deviceIdentity, validateDevice };
