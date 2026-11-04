function validateBaseUrl(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch (_) { throw Error('BASE_URL must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('BASE_URL must not include credentials, query or fragment');
}
function validateRateLimits(environment, { smoke, mode }) {
  if (mode === 'capacity') return { api: null, classifier: null, window_ms: null, enabled: false };
  const fields = { api: 'API_RATE_LIMIT_MAX', classifier: 'CLASSIFIER_RATE_LIMIT_MAX', window_ms: 'RATE_LIMIT_WINDOW_MS' };
  const result = {};
  for (const [key, name] of Object.entries(fields)) {
    const raw = environment[name];
    if (raw === undefined || raw === '') {
      if (!smoke) throw Error(`Set ${name} to the effective server value`);
      result[key] = null;
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw Error(`${name} must be a positive integer`);
    result[key] = value;
  }
  return result;
}
function validateSessions(data, baseUrl, now = Date.now()) {
  validateBaseUrl(baseUrl);
  if (!data?.complete || data.baseUrl !== baseUrl || !Array.isArray(data.users)) throw Error('Sessions are incomplete or BASE_URL differs from login');
  if (data.runId !== undefined && !/^[a-z0-9]{4,16}$/.test(data.runId)) throw Error('Invalid benchmark run ID');
  const smoke = data.counts?.guest === 6;
  const expected = smoke ? { admin: 1, manager: 1, staff: 2, guest: 6, facilities: 1, batches: 2 }
    : { admin: 10, manager: 50, staff: 500, guest: 9440, facilities: 50, batches: 250 };
  for (const role of ['admin', 'manager', 'staff', 'guest']) if (data.counts?.[role] !== expected[role]) throw Error(`Unexpected ${role} count`);
  if (!Array.isArray(data.facilities) || data.facilities.length !== expected.facilities || !Array.isArray(data.batches) || data.batches.length !== expected.batches) throw Error('Unexpected benchmark dataset size');
  if (data.users.length !== expected.admin + expected.manager + expected.staff) throw Error('Unexpected internal account count');
  if (new Set(data.users.map(user => user.id)).size !== data.users.length || new Set(data.users.map(user => user.username)).size !== data.users.length || new Set(data.users.map(user => user.token)).size !== data.users.length) throw Error('Benchmark identities and tokens must be unique');
  for (const role of ['admin', 'manager', 'staff']) if (data.users.filter(user => user.role === role).length !== expected[role]) throw Error(`Unexpected ${role} identity count`);
  if (!Number.isFinite(Date.parse(data.authenticatedAt)) || now - Date.parse(data.authenticatedAt) > 20 * 60 * 1000) throw Error('Reauthenticate sessions before running');
  for (const user of data.users) {
    if (!Number.isSafeInteger(user.id) || !user.batchId || !user.facilityId || !user.batchCode || typeof user.token !== 'string') throw Error('Incomplete benchmark identity');
    let claims;
    try { claims = JSON.parse(Buffer.from(user.token.split('.')[1], 'base64url').toString('utf8')); } catch (_) { throw Error('Malformed benchmark token'); }
    if (claims.id !== user.id || claims.username !== user.username || claims.role !== user.role || !Number.isFinite(claims.exp) || claims.exp * 1000 < now + 80 * 60 * 1000) throw Error('Benchmark identity or token expiry mismatch');
  }
  const staffById = new Map(data.users.filter(user => user.role === 'staff').map(user => [user.id, user]));
  const assignedStaff = new Set();
  for (const user of data.users.filter(user => user.role !== 'staff')) {
    if (!Array.isArray(user.assignments) || !user.assignments.length || (user.role === 'manager' && user.assignments.length !== expected.staff / expected.manager)) throw Error('Incomplete benchmark manager assignments');
    for (const assignment of user.assignments) {
      const staff = staffById.get(assignment.staffId);
      if (!staff || assignment.facilityId !== staff.facilityId || assignment.batchId !== staff.batchId || assignment.batchCode !== staff.batchCode || (user.role === 'manager' && assignment.facilityId !== user.facilityId)) throw Error('Invalid benchmark manager assignment');
      if (user.role === 'manager') {
        if (assignedStaff.has(staff.id)) throw Error('Duplicate benchmark manager assignment');
        assignedStaff.add(staff.id);
      }
    }
  }
  if (assignedStaff.size !== expected.staff) throw Error('Some staff have no benchmark manager');
  return { smoke, expected };
}
module.exports = { validateBaseUrl, validateRateLimits, validateSessions };
