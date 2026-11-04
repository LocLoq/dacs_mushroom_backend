const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { validateBaseUrl } = require('./validate-sessions.cjs');

const runId = process.env.BENCHMARK_RUN_ID;
if (!/^[a-z0-9]{4,16}$/.test(runId || '')) throw Error('Invalid BENCHMARK_RUN_ID');
const directory = path.resolve('.cache', 'benchmark', runId);
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
if (!manifest.complete || manifest.runId !== runId) throw Error('Seed is incomplete');
const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
if (!baseUrl || !process.env.BENCHMARK_PASSWORD) throw Error('Set BASE_URL and BENCHMARK_PASSWORD');
validateBaseUrl(baseUrl);
const sessions = [];
async function main() {
  for (const user of manifest.users) {
    const response = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: process.env.BENCHMARK_PASSWORD }), signal: AbortSignal.timeout(30000) });
    if (response.status !== 200) throw Error(`Login failed for benchmark role ${user.role}: HTTP ${response.status}`);
    const { token } = await response.json();
    if (!token) throw Error('Login returned no token');
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (me.status !== 200) throw Error(`auth/me failed: HTTP ${me.status}`);
    const body = await me.json();
    if (body.data?.id !== user.id || body.data?.role !== user.role) throw Error('Unexpected login identity');
    sessions.push({ ...user, token });
    await delay(Number(process.env.BENCHMARK_LOGIN_INTERVAL_MS || 350));
  }
  const filename = path.join(directory, 'sessions.json');
  fs.writeFileSync(filename, JSON.stringify({ ...manifest, baseUrl, authenticatedAt: new Date().toISOString(),
    authenticateSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), users: sessions }), { mode: 0o600 });
  console.log(`Authenticated ${sessions.length} benchmark identities; sessions are stored in ${filename}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
