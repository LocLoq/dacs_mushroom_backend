const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('recovery reports Prometheus counters separately and never invents percentiles', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ run_id: 'test1234', runs: [{ id: 'measured', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z' }] }));
  const server = http.createServer((req, res) => {
    const query = new URL(req.url, 'http://localhost').searchParams.get('query');
    let result = [];
    if (query.includes('k6_business_requests_total') && !query.includes('resets')) result = [{ metric: query.includes('by (') ? { role: 'guest', endpoint: 'species' } : {}, value: [1, '100'] }];
    if (query.includes('k6_business_failures_total') && !query.includes('resets')) result = [{ metric: { reason: 'server' }, value: [1, '5'] }];
    if (query.includes('k6_classifier_jobs_total') && !query.includes('resets')) result = [{ metric: { role: 'guest', outcome: 'timeout' }, value: [1, '3'] }];
    if (query.includes('resets')) result = [{ metric: {}, value: [1, '0'] }];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'success', data: { result } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, [path.join(__dirname, '../benchmarks/k6/recover-prometheus.cjs'), directory], {
    env: { ...process.env, BENCHMARK_PROMETHEUS_URL: `http://127.0.0.1:${server.address().port}` }, stdio: 'pipe'
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0);
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'recovered-prometheus.json')));
  assert.equal(result.requests, 100);
  assert.equal(result.failures, 5);
  assert.equal(result.business_failure_fraction, 0.05);
  assert.equal(result.exact_full_run_percentiles_available, false);
  assert.equal(result.approximate, true);
  assert.equal(result.counter_resets_detected, false);
  assert.ok(fs.existsSync(path.join(directory, 'checksums.sha256')));
});
