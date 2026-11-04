import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import execution from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';
import { open as openFile, SeekMode } from 'k6/experimental/fs';
import { setTimeout as schedule, clearTimeout } from 'k6/timers';

if (!__ENV.SESSIONS_PATH || !__ENV.BENCHMARK_IMAGE || !__ENV.BASE_URL) throw Error('Set SESSIONS_PATH, BENCHMARK_IMAGE and BASE_URL');
const users = new SharedArray('benchmark users', () => JSON.parse(open(__ENV.SESSIONS_PATH)).users);
const meta = new SharedArray('benchmark metadata', () => {
  const m = JSON.parse(open(__ENV.SESSIONS_PATH));
  return [{ counts: m.counts, batch: m.batches[0], mushroomId: m.mushroomId, publicImage: m.publicImage, baseUrl: m.baseUrl, authenticatedAt: m.authenticatedAt, imageMime: m.imageMime, runId: m.runId }];
});
const layout = new SharedArray('virtual user assignments', () => {
  const m = JSON.parse(open(__ENV.SESSIONS_PATH));
  const groups = Object.fromEntries(['admin', 'manager', 'staff'].map(role => [role, m.users.filter(u => u.role === role)]));
  const slots = [];
  if (m.counts.guest === 6) return [...m.users.map(u => ({ role: u.role, userId: u.id })), ...Array.from({ length: 6 }, () => ({ role: 'guest' }))];
  for (let n = 0; n < 10; n++) {
    slots.push({ role: 'admin', userId: groups.admin[n].id });
    for (const u of groups.manager.slice(n * 5, n * 5 + 5)) slots.push({ role: 'manager', userId: u.id });
    for (const u of groups.staff.slice(n * 50, n * 50 + 50)) slots.push({ role: 'staff', userId: u.id });
    for (let i = 0; i < 944; i++) slots.push({ role: 'guest' });
  }
  return slots;
});
const photo = await openFile(__ENV.BENCHMARK_IMAGE);
const base = __ENV.BASE_URL.replace(/\/$/, '');
if (base !== meta[0].baseUrl) throw Error('BASE_URL must match authenticated session origin');
const smoke = meta[0].counts.guest === 6;
const layoutOnly = __ENV.BENCHMARK_PHASE === 'layout';
const preflight = __ENV.BENCHMARK_PHASE === 'preflight';
const warmup = __ENV.BENCHMARK_PHASE === 'warmup';
const calibration = __ENV.BENCHMARK_PHASE === 'measured' && __ENV.BENCHMARK_CALIBRATION_VUS === '100';
const stages = smoke || warmup ? [{ duration: '5s', target: 10 }, { duration: '30s', target: 10 }, { duration: '5s', target: 0 }]
  : calibration ? [{ duration: '10s', target: 100 }, { duration: '3m', target: 100 }, { duration: '10s', target: 0 }]
  : [{ duration: '2m', target: 1000 }, { duration: '2m', target: 3000 }, { duration: '2m', target: 5000 }, { duration: '2m', target: 10000 }, { duration: '30m', target: 10000 }, { duration: '2m', target: 0 }];
export const options = {
  tags: { benchmark_run: meta[0].runId, test_phase: __ENV.BENCHMARK_PHASE || 'measured' },
  scenarios: layoutOnly ? { layout: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '30s' } }
    : preflight ? { preflight: { executor: 'per-vu-iterations', vus: 4, iterations: 1, maxDuration: '20m' } }
    : { mixed: { executor: 'ramping-vus', startVUs: 0, stages, gracefulRampDown: '15m', gracefulStop: '15m' } },
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response', 'error_code'],
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: preflight ? { 'checks{phase:business}': ['rate==1'], classifier_success: ['rate==1'] } : warmup || layoutOnly ? {} : { 'http_req_duration{phase:business,kind:read}': ['p(95)<500', 'p(99)<1000'],
    'http_req_failed{phase:business}': ['rate<0.01'], 'checks{phase:business}': ['rate>=0.99'], business_requests: ['count>0'] }
};
// Explicit submetrics keep the end-of-test summary useful without writing one
// JSON sample per request. IDs and URLs never appear in metric tags.
if (!warmup && !layoutOnly) {
  if (!preflight) for (const stage of ['ramp_1', 'ramp_2', 'ramp_3', 'ramp_4', 'hold', 'ramp_down', 'drain']) {
    options.thresholds[`http_req_duration{kind:read,phase:business,stage:${stage}}`] = ['p(95)>=0'];
  }
  const shared = ['species_list', 'species_detail', 'species_images', 'public_image', 'public_progress'];
  const internal = ['me', 'facilities', 'batches', 'batch_detail', 'batch_by_code', 'care_logs', 'growth', 'harvests', 'tasks', 'notifications', 'task_detail', 'evidence_candidates', 'care_image', 'workflow_refresh'];
  const manager = ['facility_staff', 'batch_staff', 'assignees', 'expenses', 'sales', 'financial_summary', 'report_overview', 'report_financial', 'report_cultivation', 'report_classifier', 'report_export', 'classifier_history'];
  const admin = ['admin_users', 'admin_roles', 'audit', 'report_audit', 'facility_managers'];
  const writes = ['care_create', 'growth_create', 'harvest_create', 'notification_detail', 'notification_read', 'task_create', 'task_update', 'task_open', 'task_pending', 'task_candidates', 'expense_create', 'expense_update', 'expense_delete', 'sale_create', 'sale_update', 'sale_delete', 'facility_create', 'facility_update', 'facility_delete', 'batch_create', 'batch_update', 'batch_delete', 'species_create', 'species_update', 'species_delete', 'gallery_upload', 'gallery_update', 'gallery_delete', 'manager_grant', 'manager_revoke', 'facility_staff_grant', 'facility_staff_revoke', 'batch_staff_grant', 'batch_staff_revoke', 'task_submit', 'task_review', 'admin_user_create', 'admin_user_update', 'admin_user_delete'];
  for (const [role, endpoints] of Object.entries({ guest: shared, staff: [...shared, ...internal], manager: [...shared, ...internal, ...manager], admin: [...shared, ...internal, ...manager, ...admin] })) {
    for (const endpoint of [...endpoints, ...(role === 'guest' ? [] : writes), 'classifier_submit', 'classifier_job']) {
      options.thresholds[`business_requests{endpoint:${endpoint},role:${role}}`] = ['count>=0'];
      options.thresholds[`http_req_duration{endpoint:${endpoint},role:${role}}`] = ['p(95)>=0'];
    }
  }
  for (const reason of ['rate_limit', 'auth', 'server', 'network', 'response']) options.thresholds[`business_failures{reason:${reason}}`] = ['count>=0'];
  for (const role of ['admin', 'manager', 'staff', 'guest']) {
    for (const outcome of ['succeeded', 'failed', 'timeout', 'rejected', 'invalid']) options.thresholds[`classifier_jobs{outcome:${outcome},role:${role}}`] = ['count>=0'];
    if (!preflight) for (const action of ['read', 'write', 'classify']) options.thresholds[`business_actions{action:${action},role:${role}}`] = ['count>=0'];
  }
  if (preflight) {
    const internalReads = internal.filter(name => !['task_detail', 'evidence_candidates', 'care_image', 'workflow_refresh'].includes(name));
    const managerWrites = ['facility_create', 'facility_update', 'facility_delete', 'batch_create', 'batch_update', 'batch_delete', 'species_create', 'species_update', 'species_delete', 'gallery_upload', 'gallery_update', 'gallery_delete', 'facility_staff_grant', 'facility_staff_revoke', 'batch_staff_grant', 'batch_staff_revoke', 'task_create', 'task_update', 'task_review', 'expense_create', 'expense_update', 'expense_delete', 'sale_create', 'sale_update', 'sale_delete'];
    const required = {
      guest: [...shared, 'classifier_submit', 'classifier_job'],
      staff: [...shared, ...internalReads, 'task_detail', 'evidence_candidates', 'care_image', 'notification_detail', 'notification_read', 'care_create', 'growth_create', 'harvest_create', 'task_submit'],
      manager: [...shared, ...internalReads, ...manager, ...managerWrites],
      admin: [...shared, ...internalReads, ...manager, ...admin, ...managerWrites, 'manager_grant', 'manager_revoke', 'admin_user_create', 'admin_user_update', 'admin_user_delete']
    };
    for (const [role, endpoints] of Object.entries(required)) for (const endpoint of endpoints) options.thresholds[`business_requests{endpoint:${endpoint},role:${role}}`] = ['count>0'];
  }
}
const requests = new Counter('business_requests');
const failures = new Counter('business_failures');
const actions = new Counter('business_actions');
const jobs = new Counter('classifier_jobs');
const admissionRejected = new Counter('classifier_admission_rejected');
const jobSuccess = new Rate('classifier_success');
const queueTime = new Trend('classifier_queue_ms');
const processingTime = new Trend('classifier_processing_ms');
const totalTime = new Trend('classifier_total_ms');
const modelTime = new Trend('classifier_model_ms');
const preprocessTime = new Trend('classifier_preprocess_ms');
const socketEvents = new Counter('socket_events');
const pause = ms => new Promise(resolve => schedule(resolve, ms));

export function setup() {
  // k6 re-evaluates the init context for handleSummary after the run; checking
  // session age there discards summaries of runs longer than 45 minutes.
  if (Date.now() - Date.parse(meta[0].authenticatedAt) > 45 * 60 * 1000) throw Error('Sessions are older than 45 minutes; authenticate again');
  const expected = meta[0].counts, counts = { admin: 0, manager: 0, staff: 0, guest: 0 };
  const identities = new Set();
  for (const slot of layout) {
    if (!Object.hasOwn(counts, slot.role)) throw Error('Unknown VU role');
    counts[slot.role]++;
    if (slot.role !== 'guest') {
      if (identities.has(slot.userId)) throw Error('Duplicate VU identity');
      identities.add(slot.userId);
    }
  }
  for (const role of Object.keys(counts)) if (counts[role] !== expected[role]) throw Error(`Invalid ${role} VU count`);
  if (identities.size !== users.length || users.some(user => !identities.has(user.id))) throw Error('VU identities do not match sessions');
}

async function request(user, method, pathname, name, body, expected = 200, kind = 'read') {
  const headers = user.token ? { Authorization: `Bearer ${user.token}` } : {};
  const multipart = body && (body.image || body.images);
  if (body && !multipart) headers['Content-Type'] = 'application/json';
  const payload = body && !multipart ? JSON.stringify(body) : body;
  const elapsed = (Date.now() - execution.scenario.startTime) / 1000;
  const bounds = smoke || warmup ? [5, 10, 15, 20, 35, 40] : [120, 240, 360, 480, 2280, 2400];
  const stage = ['ramp_1', 'ramp_2', 'ramp_3', 'ramp_4', 'hold', 'ramp_down', 'drain'][bounds.findIndex(n => elapsed < n) < 0 ? 6 : bounds.findIndex(n => elapsed < n)];
  const tags = { phase: 'business', role: user.role, endpoint: name, name, kind, method, stage };
  const res = await http.asyncRequest(method, `${base}${pathname}`, payload, { headers, tags, timeout: '30s' });
  requests.add(1, tags);
  let ok = res.status === expected;
  if (ok) {
    const contentType = (res.headers['Content-Type'] || '').toLowerCase();
    if (name === 'care_image' || name === 'public_image') ok = contentType.startsWith('image/') && !!res.body;
    else if (name === 'report_export') ok = contentType.includes('csv') && !!res.body;
    else {
      try {
        const data = res.json();
        ok = !!data && typeof data === 'object' && (method !== 'GET' || Object.hasOwn(data, 'data'));
        if (name === 'classifier_submit') ok = ok && typeof data.jobId === 'string';
        if (name === 'classifier_job') ok = ok && ['QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED'].includes(data.data?.status);
      } catch (_) { ok = false; }
    }
  }
  check(res, { 'expected status and response': () => ok }, { phase: 'business', role: user.role, endpoint: name });
  if (!ok) failures.add(1, { ...tags, reason: res.status === 429 ? 'rate_limit' : [401, 403].includes(res.status) ? 'auth' : res.status >= 500 ? 'server' : res.status === 0 ? 'network' : 'response' });
  return res;
}

// Engine.IO v4 + Socket.IO namespace handshake over the native k6 WebSocket.
function connectSocket(user, namespace, onRefresh) {
  let socket, stopped = false, retry, connected = false;
  const state = { get connected() { return connected; }, emit(event, data) {
    if (connected) socket.send(`42${namespace === '/' ? '' : `${namespace},`}${JSON.stringify([event, data])}`);
  }, close() { stopped = true; connected = false; if (retry) clearTimeout(retry); if (socket) socket.close(); } };
  function connect() {
    if (stopped) return;
    socket = new WebSocket(`${base.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`);
    socket.onmessage = event => {
      const message = String(event.data);
      if (message[0] === '0') socket.send(namespace === '/' ? '40' : `40${namespace},${JSON.stringify({ token: user.token })}`);
      else if (message === '2') socket.send('3');
      else if (message.startsWith(namespace === '/' ? '40' : `40${namespace},`)) { connected = true; socketEvents.add(1, { role: user.role, namespace, event: 'connected' }); if (state.onconnect) state.onconnect(); }
      else if (message.startsWith(namespace === '/' ? '44' : `44${namespace},`)) { socketEvents.add(1, { role: user.role, namespace, event: 'rejected' }); socket.close(); }
      else if (message.startsWith('42')) {
        const payload = namespace === '/' ? message.slice(2) : message.slice(message.indexOf(',') + 1);
        try { const [eventName, data] = JSON.parse(payload); if (eventName === 'refresh') { socketEvents.add(1, { role: user.role, namespace, event: 'refresh' }); onRefresh(data); } } catch (_) { socketEvents.add(1, { role: user.role, namespace, event: 'invalid' }); }
      }
    };
    socket.onerror = () => socketEvents.add(1, { role: user.role, namespace, event: 'error' });
    socket.onclose = () => { connected = false; socketEvents.add(1, { role: user.role, namespace, event: 'closed' }); if (!stopped) retry = schedule(connect, 1000); };
  }
  connect();
  return state;
}

async function imageFile() {
  const stat = await photo.stat();
  const buffer = new Uint8Array(stat.size);
  await photo.seek(0, SeekMode.Start);
  let offset = 0;
  while (offset < buffer.length) { const read = await photo.read(buffer.subarray(offset)); if (!read) throw Error('Cannot read benchmark image'); offset += read; }
  const mime = meta[0].imageMime || (/\.png$/i.test(__ENV.BENCHMARK_IMAGE) ? 'image/png' : 'image/jpeg');
  return http.file(buffer.buffer, `mushroom.${mime === 'image/png' ? 'png' : 'jpg'}`, mime);
}

async function classify(user) {
  const start = Date.now();
  const res = await request(user, 'POST', '/api/mushroom-classifier/classify', 'classifier_submit', { image: await imageFile() }, 202, 'write');
  if (res.status !== 202) {
    try { if (res.status === 503 && res.json('code') === 'CLASSIFIER_QUEUE_FULL') admissionRejected.add(1, { role: user.role }); } catch (_) {}
    jobs.add(1, { role: user.role, outcome: 'rejected' }); jobSuccess.add(false, { role: user.role }); return;
  }
  const jobId = res.json('jobId');
  if (!jobId) { jobs.add(1, { role: user.role, outcome: 'invalid' }); jobSuccess.add(false, { role: user.role }); return; }
  let dirty = true;
  const socket = connectSocket(user, '/', () => { dirty = true; });
  socket.onconnect = () => { socket.emit('subscribe_job', jobId); dirty = true; };
  const deadline = start + Number(__ENV.CLASSIFIER_DEADLINE_MS || 900000);
  let lastPoll = 0, outcome = 'timeout', nextPoll = 0, retryDelay = 5000;
  try {
    while (Date.now() < deadline) {
      if (dirty || Date.now() >= nextPoll) {
        dirty = false; lastPoll = Date.now();
        const snapshot = await request(user, 'GET', `/api/mushroom-classifier/jobs/${jobId}`, 'classifier_job', undefined, 200, 'poll');
        if (snapshot.status === 200) {
          retryDelay = 5000;
          nextPoll = Date.now() + (socket.connected ? 15000 : 5000) + Math.random() * 1000;
          const data = snapshot.json('data');
          if (['SUCCEEDED', 'FAILED'].includes(data.status)) {
            outcome = data.status.toLowerCase();
            if (data.startedAt && data.queuedAt) queueTime.add(Date.parse(data.startedAt) - Date.parse(data.queuedAt), { role: user.role });
            if (data.completedAt && data.startedAt) processingTime.add(Date.parse(data.completedAt) - Date.parse(data.startedAt), { role: user.role });
            if (Number.isFinite(data.result?.timings?.modelMs)) modelTime.add(data.result.timings.modelMs, { role: user.role });
            if (Number.isFinite(data.result?.timings?.preprocessMs)) preprocessTime.add(data.result.timings.preprocessMs, { role: user.role });
            break;
          }
        } else {
          nextPoll = Date.now() + retryDelay + Math.random() * 1000;
          retryDelay = Math.min(15000, retryDelay * 2);
        }
      }
      await pause(socket.connected ? 250 : 1000);
    }
  } finally { socket.close(); }
  totalTime.add(Date.now() - start, { role: user.role, outcome });
  jobs.add(1, { role: user.role, outcome });
  jobSuccess.add(outcome === 'succeeded', { role: user.role });
}

function reads(user) {
  const batch = user.batchId || meta[0].batch.id, code = user.batchCode || meta[0].batch.code;
  const common = [
    ['species_list', '/api/mushroom-species'], ['species_detail', `/api/mushroom-species/${meta[0].mushroomId}`],
    ['species_images', `/api/mushroom-species/${meta[0].mushroomId}/images`], ['public_image', meta[0].publicImage],
    ['public_progress', `/api/public/cultivation-batches/${encodeURIComponent(code)}/growth-progress/current`]
  ];
  if (user.role === 'guest') return common;
  const staff = [...common, ['me', '/api/auth/me'], ['facilities', '/api/production-facilities'], ['batches', '/api/cultivation-batches'],
    ['batch_detail', `/api/cultivation-batches/${batch}`], ['batch_by_code', `/api/cultivation-batches/by-code/${encodeURIComponent(code)}`],
    ['care_logs', `/api/cultivation-batches/${batch}/care-logs`], ['growth', `/api/cultivation-batches/${batch}/growth-progress`],
    ['harvests', `/api/cultivation-batches/${batch}/harvests`], ['tasks', '/api/dashboard/tasks'], ['notifications', '/api/notifications']];
  if (user.taskId) staff.push(['task_detail', `/api/dashboard/tasks/${user.taskId}`], ['evidence_candidates', `/api/dashboard/tasks/${user.taskId}/evidence-candidates`]);
  if (user.careImage) staff.push(['care_image', user.careImage]);
  if (user.role === 'staff') return staff;
  const manager = [...staff, ['facility_staff', `/api/production-facilities/${user.facilityId}/staff`], ['batch_staff', `/api/cultivation-batches/${batch}/staff`],
    ['assignees', `/api/dashboard/task-assignees?batchId=${batch}`], ['expenses', `/api/cultivation-batches/${batch}/expenses`],
    ['sales', `/api/cultivation-batches/${batch}/sales`], ['financial_summary', `/api/cultivation-batches/${batch}/financial-summary`],
    ['report_overview', '/api/reports/overview'], ['report_financial', '/api/reports/financial'], ['report_cultivation', '/api/reports/cultivation'],
    ['report_classifier', '/api/reports/classifier'], ['report_export', '/api/reports/cultivation/export?format=csv'], ['classifier_history', '/api/mushroom-classifier/history']];
  if (user.role === 'manager') return manager;
  return [...manager, ['admin_users', '/api/admin/users'], ['admin_roles', '/api/admin/roles'], ['audit', '/api/admin/audit-logs'],
    ['report_audit', '/api/reports/audit'], ['facility_managers', `/api/production-facilities/${user.facilityId}/managers`]];
}
async function speciesWorkflow(user, marker, gallery) {
  const scientificName = `${marker}_${execution.vu.idInTest}_${Date.now()}`;
  const species = await request(user, 'POST', '/api/mushroom-species', 'species_create', { scientificName, commonName: marker, family: 'Benchmark', genus: 'Benchmark', edibilityStatus: 'EDIBLE' }, 201, 'write');
  if (species.status !== 201) return;
  const id = species.json('data.id'), url = `/api/mushroom-species/${id}`;
  await request(user, 'PUT', url, 'species_update', { commonName: `${marker}_updated` }, 200, 'write');
  if (gallery) {
    const uploaded = await request(user, 'POST', `${url}/images`, 'gallery_upload', { images: await imageFile(), isPublic: 'false' }, 201, 'write');
    if (uploaded.status === 201) {
      const imageId = uploaded.json('data')[0]?.id;
      if (imageId) {
        await request(user, 'PATCH', `${url}/images/${imageId}`, 'gallery_update', { isPublic: true }, 200, 'write');
        await request(user, 'DELETE', `${url}/images/${imageId}`, 'gallery_delete', undefined, 200, 'write');
      }
    }
  }
  await request(user, 'DELETE', url, 'species_delete', undefined, 200, 'write');
}

async function writeAction(user) {
  if (user.role === 'guest') return;
  const batch = user.batchId, marker = `bn_${meta[0].runId}_load`;
  const selection = Math.random();
  if (user.role === 'staff' && selection < 0.25) {
    const tasks = await request(user, 'GET', `/api/dashboard/tasks?status=TODO&batchId=${batch}`, 'task_open');
    if (tasks.status !== 200 || !tasks.json('data').length) return;
    const taskId = tasks.json('data')[0].id;
    const candidates = await request(user, 'GET', `/api/dashboard/tasks/${taskId}/evidence-candidates?type=CARE_LOG`, 'task_candidates');
    if (candidates.status !== 200) return;
    let recordId = candidates.json('data')[0]?.recordId;
    if (!recordId) {
      const care = await request(user, 'POST', `/api/cultivation-batches/${batch}/care-logs`, 'care_create', { actionType: 'WATERING', notes: marker }, 201, 'write');
      if (care.status !== 201) return;
      recordId = care.json('data.id');
    }
    await request(user, 'POST', `/api/dashboard/tasks/${taskId}/submissions`, 'task_submit', { evidence: [{ type: 'CARE_LOG', recordId }] }, 201, 'write');
    return;
  }
  if (user.role !== 'staff' && selection < 0.2) {
    const pending = await request(user, 'GET', `/api/dashboard/tasks?status=PENDING_REVIEW&batchId=${batch}`, 'task_pending');
    if (pending.status !== 200 || !pending.json('data').length) return;
    const taskId = pending.json('data')[0].id;
    const detail = await request(user, 'GET', `/api/dashboard/tasks/${taskId}`, 'task_detail');
    if (detail.status !== 200) return;
    const submission = detail.json('data.submissions')?.find(row => row.status === 'PENDING');
    if (submission) await request(user, 'POST', `/api/dashboard/tasks/${taskId}/submissions/${submission.id}/review`, 'task_review', { decision: 'APPROVE' }, 200, 'write');
    return;
  }
  if (user.role !== 'staff' && selection < 0.4) {
    const created = await request(user, 'POST', '/api/production-facilities', 'facility_create', { name: marker, address: 'Benchmark', facilityType: 'HOUSEHOLD' }, 201, 'write');
    if (created.status !== 201) return;
    const facility = created.json('data.id'), facilityPath = `/api/production-facilities/${facility}`;
    const added = await request(user, 'POST', `${facilityPath}/staff`, 'facility_staff_grant', { userId: user.staffId }, 201, 'write');
    const newBatch = await request(user, 'POST', '/api/cultivation-batches', 'batch_create', { facilityId: facility, mushroomId: meta[0].mushroomId, startDate: new Date().toISOString() }, 201, 'write');
    if (newBatch.status === 201) {
      const id = newBatch.json('data.id');
      if (added.status === 201) {
        const assigned = await request(user, 'POST', `/api/cultivation-batches/${id}/staff`, 'batch_staff_grant', { userId: user.staffId }, 201, 'write');
        if (assigned.status === 201) await request(user, 'DELETE', `/api/cultivation-batches/${id}/staff/${user.staffId}`, 'batch_staff_revoke', undefined, 200, 'write');
      }
      await request(user, 'DELETE', `/api/cultivation-batches/${id}`, 'batch_delete', undefined, 200, 'write');
    }
    if (added.status === 201) await request(user, 'DELETE', `${facilityPath}/staff/${user.staffId}`, 'facility_staff_revoke', undefined, 200, 'write');
    await request(user, 'DELETE', facilityPath, 'facility_delete', undefined, 200, 'write');
    return;
  }
  if (user.role !== 'staff' && selection < 0.5) { await speciesWorkflow(user, marker, true); return; }
  if (user.role === 'admin' && selection < 0.65) {
    const roles = await request(user, 'GET', '/api/admin/roles', 'admin_roles');
    if (roles.status !== 200) return;
    const roleId = roles.json('data').find(role => role.name === 'staff')?.id;
    if (!roleId) return;
    const username = `${marker}_${execution.vu.idInTest}_${execution.vu.iterationInInstance}`;
    const created = await request(user, 'POST', '/api/admin/users', 'admin_user_create', { username, password: `${marker}_${Math.random()}`, full_name: marker, phone_number: '0000000000', email: 'bench@example.test', role_id: roleId }, 201, 'write');
    if (created.status === 201) await request(user, 'DELETE', `/api/admin/users/${created.json('data.id')}`, 'admin_user_delete', undefined, 200, 'write');
    return;
  }
  const choices = user.role === 'staff' ? [
    ['care_create', `/api/cultivation-batches/${batch}/care-logs`, { actionType: 'WATERING', notes: marker }],
    ['growth_create', `/api/cultivation-batches/${batch}/growth-progress`, { stage: 'FRUITING', notes: marker }],
    ['harvest_create', `/api/cultivation-batches/${batch}/harvests`, { totalYieldKg: 0.1, notes: marker }]
  ] : [
    ['task_create', '/api/dashboard/tasks', { title: marker, batchId: batch, assigneeUserId: user.staffId }],
    ['expense_create', `/api/cultivation-batches/${batch}/expenses`, { name: marker, category: 'MATERIAL', quantity: 1, unit: 'kg', unitPrice: 1 }],
    ['facility_create', '/api/production-facilities', { name: marker, address: 'Benchmark', facilityType: 'HOUSEHOLD' }]
  ];
  const [name, url, body] = choices[Math.floor(Math.random() * choices.length)];
  await request(user, 'POST', url, name, body, 201, 'write');
}

async function preflightWrites(user) {
  if (user.role === 'guest') { await classify(user); return; }
  if (user.role === 'staff') {
    await request(user, 'POST', `/api/cultivation-batches/${user.batchId}/care-logs`, 'care_create', { actionType: 'WATERING', notes: 'benchmark preflight' }, 201, 'write');
    await request(user, 'POST', `/api/cultivation-batches/${user.batchId}/growth-progress`, 'growth_create', { stage: 'FRUITING', notes: 'benchmark preflight' }, 201, 'write');
    await request(user, 'POST', `/api/cultivation-batches/${user.batchId}/harvests`, 'harvest_create', { totalYieldKg: 0.1, notes: 'benchmark preflight' }, 201, 'write');
    await request(user, 'GET', `/api/notifications/${user.notificationId}`, 'notification_detail');
    await request(user, 'PATCH', `/api/notifications/${user.notificationId}/read`, 'notification_read', {}, 200, 'write');
    return;
  }
  const marker = `bn_${meta[0].runId}_preflight_${user.role}`;
  await speciesWorkflow(user, marker, true);
  const created = await request(user, 'POST', '/api/production-facilities', 'facility_create', { name: marker, address: 'Benchmark', facilityType: 'HOUSEHOLD' }, 201, 'write');
  if (created.status !== 201) return;
  const facilityId = created.json('data.id');
  const path = `/api/production-facilities/${facilityId}`;
  await request(user, 'PUT', path, 'facility_update', { address: 'Benchmark updated' }, 200, 'write');
  if (user.role === 'admin') {
    const manager = users.find(row => row.role === 'manager');
    await request(user, 'POST', `${path}/managers`, 'manager_grant', { userId: manager.id }, 201, 'write');
    await request(user, 'DELETE', `${path}/managers/${manager.id}`, 'manager_revoke', undefined, 200, 'write');
  }
  await request(user, 'POST', `${path}/staff`, 'facility_staff_grant', { userId: user.staffId }, 201, 'write');
  const batch = await request(user, 'POST', '/api/cultivation-batches', 'batch_create', { facilityId, mushroomId: meta[0].mushroomId, startDate: new Date().toISOString() }, 201, 'write');
  if (batch.status === 201) {
    const batchId = batch.json('data.id');
    await request(user, 'PUT', `/api/cultivation-batches/${batchId}`, 'batch_update', { status: 'INCUBATION' }, 200, 'write');
    await request(user, 'POST', `/api/cultivation-batches/${batchId}/staff`, 'batch_staff_grant', { userId: user.staffId }, 201, 'write');
    await request(user, 'DELETE', `/api/cultivation-batches/${batchId}/staff/${user.staffId}`, 'batch_staff_revoke', undefined, 200, 'write');
    await request(user, 'DELETE', `/api/cultivation-batches/${batchId}`, 'batch_delete', undefined, 200, 'write');
  }
  await request(user, 'DELETE', `${path}/staff/${user.staffId}`, 'facility_staff_revoke', undefined, 200, 'write');
  await request(user, 'DELETE', path, 'facility_delete', undefined, 200, 'write');
  const task = await request(user, 'POST', '/api/dashboard/tasks', 'task_create', { title: marker, batchId: user.batchId, assigneeUserId: user.staffId }, 201, 'write');
  if (task.status === 201) {
    const staffUser = users.find(row => row.id === user.staffId);
    const evidence = await request(staffUser, 'POST', `/api/cultivation-batches/${user.batchId}/care-logs`, 'care_create', { actionType: 'WATERING', notes: marker }, 201, 'write');
    if (evidence.status === 201) {
      const taskId = task.json('data.id');
      await request(user, 'PATCH', `/api/dashboard/tasks/${taskId}`, 'task_update', { title: `${marker}_updated` }, 200, 'write');
      const submission = await request(staffUser, 'POST', `/api/dashboard/tasks/${taskId}/submissions`, 'task_submit', { evidence: [{ type: 'CARE_LOG', recordId: evidence.json('data.id') }] }, 201, 'write');
      if (submission.status === 201) await request(user, 'POST', `/api/dashboard/tasks/${taskId}/submissions/${submission.json('data.id')}/review`, 'task_review', { decision: 'APPROVE' }, 200, 'write');
    }
  }
  const expensePath = `/api/cultivation-batches/${user.batchId}/expenses`;
  const expense = await request(user, 'POST', expensePath, 'expense_create', { name: marker, category: 'MATERIAL', quantity: 1, unit: 'kg', unitPrice: 1 }, 201, 'write');
  if (expense.status === 201) {
    await request(user, 'PATCH', `${expensePath}/${expense.json('data.id')}`, 'expense_update', { notes: marker }, 200, 'write');
    await request(user, 'DELETE', `${expensePath}/${expense.json('data.id')}`, 'expense_delete', undefined, 200, 'write');
  }
  const salePath = `/api/cultivation-batches/${user.batchId}/sales`;
  const sale = await request(user, 'POST', salePath, 'sale_create', { quantityKg: 1, unitPrice: 1 }, 201, 'write');
  if (sale.status === 201) {
    await request(user, 'PATCH', `${salePath}/${sale.json('data.id')}`, 'sale_update', { buyer: marker }, 200, 'write');
    await request(user, 'DELETE', `${salePath}/${sale.json('data.id')}`, 'sale_delete', undefined, 200, 'write');
  }
  if (user.role === 'admin') {
    const roles = await request(user, 'GET', '/api/admin/roles', 'admin_roles');
    if (roles.status === 200) {
      const roleId = roles.json('data').find(role => role.name === 'staff').id;
      const account = await request(user, 'POST', '/api/admin/users', 'admin_user_create', { username: `${marker}_${Date.now()}`, password: `${marker}_${Math.random()}`, full_name: marker, phone_number: '0000000000', email: 'bench@example.test', role_id: roleId }, 201, 'write');
      if (account.status === 201) {
        await request(user, 'PUT', `/api/admin/users/${account.json('data.id')}`, 'admin_user_update', { full_name: `${marker}_updated` }, 200, 'write');
        await request(user, 'DELETE', `/api/admin/users/${account.json('data.id')}`, 'admin_user_delete', undefined, 200, 'write');
      }
    }
  }
}

export default async function () {
  if (layoutOnly) return;
  const slot = preflight ? [{ role: 'admin' }, { role: 'manager' }, { role: 'staff' }, { role: 'guest' }][execution.vu.idInTest - 1] : layout[execution.vu.idInTest - 1];
  if (!slot) throw Error('VU count exceeds configured identities');
  const identity = slot.role === 'guest' ? { role: 'guest' } : users.find(row => preflight ? row.role === slot.role : row.id === slot.userId);
  const user = identity.assignments?.length ? { ...identity, ...identity.assignments[Math.floor(Math.random() * identity.assignments.length)] } : identity;
  const refreshPending = new Map();
  const workflow = user.token ? connectSocket(user, '/workflow', data => {
    const id = Number(data?.id);
    const paths = { tasks: '/api/dashboard/tasks', notifications: '/api/notifications', batches: '/api/cultivation-batches',
      permissions: '/api/production-facilities', 'care-logs': Number.isSafeInteger(id) && id > 0 ? `/api/cultivation-batches/${id}/care-logs` : null,
      'growth-progress': Number.isSafeInteger(id) && id > 0 ? `/api/cultivation-batches/${id}/growth-progress` : null,
      harvests: Number.isSafeInteger(id) && id > 0 ? `/api/cultivation-batches/${id}/harvests` : null };
    if (paths[data?.resource]) refreshPending.set(data.resource, paths[data.resource]);
  }) : null;
  const end = Date.now() + Number(__ENV.SESSION_MS || 120000);
  try {
    const endpoints = reads(user);
    if (preflight) {
      for (const [name, url] of endpoints) await request(user, 'GET', url, name);
      await preflightWrites(user);
      return;
    }
    while (Date.now() < end) {
      const selector = Math.random();
      if (selector < 0.05) { actions.add(1, { role: user.role, action: 'classify' }); await classify(user); }
      else if (selector < 0.15 && user.role !== 'guest') { actions.add(1, { role: user.role, action: 'write' }); await writeAction(user); }
      else {
        actions.add(1, { role: user.role, action: 'read' });
        const [name, url] = endpoints[Math.floor(Math.random() * endpoints.length)];
        await request(user, 'GET', url, name);
      }
      for (const [resource, url] of refreshPending) {
        refreshPending.delete(resource);
        await request(user, 'GET', url, 'workflow_refresh');
      }
      await pause(2000 + Math.random() * 3000);
    }
  } finally { if (workflow) workflow.close(); }
}

export function handleSummary(data) {
  const { setup_data, ...safe } = data;
  return { [__ENV.SUMMARY_PATH || 'summary.json']: JSON.stringify(safe, null, 2) };
}
