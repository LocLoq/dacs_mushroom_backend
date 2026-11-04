const KEY = 'mushroomClassifier:admission';
const RESERVE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
return 1`;

async function reserve(client, id, limit, leaseMs = 1200000) {
    const now = Date.now();
    return Number(await client.eval(RESERVE, 1, KEY, now, limit, now + leaseMs, id)) === 1;
}
let defaultClient;
function setClient(client) { defaultClient = client; }
async function release(id, client) {
    if (!id) return;
    try {
        client ||= defaultClient;
        if (client && client.status === 'ready') await client.zrem(KEY, id);
    } catch (error) { console.error('Classifier admission release failed:', error.message); }
}
module.exports = { reserve, release, setClient, KEY };
