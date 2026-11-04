const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateRateLimits, validateSessions } = require('../benchmarks/k6/validate-sessions.cjs');

const now = Date.now();
function fixture(smoke = false) {
  const counts = smoke ? { admin: 1, manager: 1, staff: 2, guest: 6 } : { admin: 10, manager: 50, staff: 500, guest: 9440 };
  const users = [];
  for (const role of ['admin', 'manager', 'staff']) for (let index = 0; index < counts[role]; index++) {
    const id = users.length + 1, username = `bench_${id}`;
    const claims = { id, username, role, exp: Math.floor((now + 100 * 60000) / 1000) };
    users.push({ id, username, role, token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`, batchId: 1, facilityId: 1, batchCode: 'benchmark' });
  }
  const staff = users.filter(user => user.role === 'staff');
  const managers = users.filter(user => user.role === 'manager');
  const pair = user => ({ staffId: user.id, facilityId: user.facilityId, batchId: user.batchId, batchCode: user.batchCode });
  managers.forEach((manager, index) => { manager.assignments = staff.slice(index * (counts.staff / counts.manager), (index + 1) * (counts.staff / counts.manager)).map(pair); });
  users.filter(user => user.role === 'admin').forEach(user => { user.assignments = [pair(staff[0])]; });
  return { complete: true, baseUrl: 'http://127.0.0.1:8080', authenticatedAt: new Date(now).toISOString(), counts, users,
    facilities: Array(smoke ? 1 : 50).fill(1), batches: Array(smoke ? 2 : 250).fill({ id: 1 }) };
}

test('benchmark validates both full and smoke identity populations', () => {
  assert.equal(validateSessions(fixture(), 'http://127.0.0.1:8080', now).expected.guest, 9440);
  assert.equal(validateSessions(fixture(true), 'http://127.0.0.1:8080', now).smoke, true);
});

test('benchmark refuses duplicate identities, wrong targets and expired tokens', () => {
  const data = fixture(true);
  assert.throws(() => validateSessions(data, 'http://elsewhere', now), /BASE_URL/);
  assert.throws(() => validateSessions(data, 'http://user:secret@127.0.0.1:8080', now), /credentials/);
  data.users[1].token = data.users[0].token;
  assert.throws(() => validateSessions(data, data.baseUrl, now), /unique/);
  const expired = fixture(true);
  const user = expired.users[0];
  user.token = `header.${Buffer.from(JSON.stringify({ id: user.id, username: user.username, role: user.role, exp: Math.floor(now / 1000) })).toString('base64url')}.signature`;
  assert.throws(() => validateSessions(expired, expired.baseUrl, now), /expiry/);
  const invalidAssignment = fixture(true);
  invalidAssignment.users.find(user => user.role === 'manager').assignments[0].staffId = 999;
  assert.throws(() => validateSessions(invalidAssignment, invalidAssignment.baseUrl, now), /assignment/);
});

test('full benchmark requires explicit, valid server rate limits', () => {
  assert.throws(() => validateRateLimits({}, { smoke: false, mode: 'realistic' }), /API_RATE_LIMIT_MAX/);
  assert.deepEqual(validateRateLimits({}, { smoke: true, mode: 'realistic' }), { api: null, classifier: null, window_ms: null });
  const environment = { API_RATE_LIMIT_MAX: '300', CLASSIFIER_RATE_LIMIT_MAX: '10', RATE_LIMIT_WINDOW_MS: '60000' };
  assert.deepEqual(validateRateLimits(environment, { smoke: false, mode: 'realistic' }), { api: 300, classifier: 10, window_ms: 60000 });
  assert.throws(() => validateRateLimits({ ...environment, CLASSIFIER_RATE_LIMIT_MAX: '0' }, { smoke: false, mode: 'realistic' }), /positive integer/);
  assert.deepEqual(validateRateLimits({}, { smoke: false, mode: 'capacity' }), { api: null, classifier: null, window_ms: null, enabled: false });
});
