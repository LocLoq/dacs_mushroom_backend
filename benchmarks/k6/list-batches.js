import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const baseUrl = (__ENV.BASE_URL || 'http://172.23.87.58:8080').replace(/\/$/, '');
const requests = new Counter('business_requests');
export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '60s',
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    'http_req_duration{phase:business}': ['p(95)<500', 'p(99)<1000'],
    'http_req_failed{phase:business}': ['rate<0.01'],
    'checks{phase:business}': ['rate>=0.99'],
    business_requests: ['count>0'],
  },
};

export function setup() {
  if (!__ENV.TEST_USER || !__ENV.TEST_PASSWORD) throw new Error('Set TEST_USER and TEST_PASSWORD');
  const response = http.post(`${baseUrl}/api/login`, JSON.stringify({
    username: __ENV.TEST_USER, password: __ENV.TEST_PASSWORD,
  }), { headers: { 'Content-Type': 'application/json' },
    tags: { phase: 'setup', name: 'login' }, timeout: '10s' });
  if (response.status !== 200) throw new Error(`Login failed: HTTP ${response.status}`);
  const token = response.json('token');
  if (!token) throw new Error('Missing JWT');
  const probe = http.get(`${baseUrl}/api/cultivation-batches?page=1&limit=10`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { phase: 'setup', name: 'data_probe' }, timeout: '10s',
  });
  if (probe.status !== 200) throw new Error(`Data probe failed: HTTP ${probe.status}`);
  const totalItems = probe.json('pagination.totalItems');
  if (!Number.isInteger(totalItems) || totalItems < 1) throw new Error('Dataset must contain batches');
  console.log(`Dataset: ${totalItems} batches; page=1; limit=10`);
  return { token, totalItems };
}

export default function ({ token, totalItems }) {
  const response = http.get(`${baseUrl}/api/cultivation-batches?page=1&limit=10`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { phase: 'business', name: 'list_batches' }, timeout: '10s',
  });
  requests.add(1);
  let body;
  try { body = response.json(); } catch (_) { body = null; }
  check(response, {
    'HTTP 200': (r) => r.status === 200,
    'Valid data and pagination': () => Array.isArray(body?.data)
      && body.data.length === Math.min(10, totalItems)
      && body.pagination?.currentPage === 1
      && body.pagination?.pageSize === 10
      && body.pagination?.totalItems === totalItems,
  }, { phase: 'business' });
  sleep(Number(__ENV.THINK_TIME || 1));
}

export function handleSummary(data) {
  // k6 includes setup() return values (including the JWT) in the legacy summary.
  const { setup_data, ...safeData } = data;
  return {
    [__ENV.SUMMARY_PATH || 'summary.json']: JSON.stringify(safeData, null, 2),
    stdout: JSON.stringify(safeData, null, 2) + '\n',
  };
}
