// Recover aggregate counters from Prometheus when k6 could not write its summary.
// Window quantiles cannot be combined into exact whole-run percentiles.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw Error('Usage: node recover-prometheus.cjs RESULTS_DIR');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
const run = metadata.runs?.find(row => row.id === 'measured');
if (!/^[a-z0-9]{4,16}$/.test(metadata.run_id || '') || !run?.started_at || !run?.finished_at) throw Error('A completed measured window and valid run ID are required');
const begin = Date.parse(run.started_at) / 1000, end = Date.parse(run.finished_at) / 1000;
const seconds = Math.ceil(end - begin + 10), at = Math.floor(end + 5);
if (!Number.isFinite(seconds) || seconds <= 10 || seconds > 86400) throw Error('Invalid measured window');
const origin = process.env.BENCHMARK_PROMETHEUS_URL || 'http://127.0.0.1:9090';
const base = new URL(origin);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('Invalid Prometheus URL');
const selector = `benchmark_run="${metadata.run_id}",test_phase="measured"`;
const range = `[${seconds}s] @ ${at}`;
const counter = name => `${name}{${selector}}${range}`;
const expressions = {
  requests: `sum(max_over_time(${counter('k6_business_requests_total')}))`,
  http_requests: `sum(max_over_time(k6_http_reqs_total{${selector},phase="business"}${range}))`,
  requests_by_role_endpoint: `sum by (role,endpoint) (max_over_time(${counter('k6_business_requests_total')}))`,
  failures_by_reason: `sum by (reason) (max_over_time(${counter('k6_business_failures_total')}))`,
  actions_by_role_type: `sum by (role,action) (max_over_time(${counter('k6_business_actions_total')}))`,
  classifier_jobs_by_role_outcome: `sum by (role,outcome) (max_over_time(${counter('k6_classifier_jobs_total')}))`,
  realtime_by_role_event: `sum by (role,namespace,event) (max_over_time(${counter('k6_socket_events_total')}))`,
  request_counter_resets: `sum(resets(${counter('k6_business_requests_total')}))`,
  failure_counter_resets: `sum(resets(${counter('k6_business_failures_total')}))`,
  job_counter_resets: `sum(resets(${counter('k6_classifier_jobs_total')}))`
};
async function query(expression) {
  const url = new URL('/api/v1/query', base);
  url.searchParams.set('query', expression);
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Prometheus HTTP ${response.status}`);
  const data = await response.json();
  if (data.status !== 'success') throw Error('Prometheus query failed');
  return data.data.result.map(item => ({ labels: item.metric, value: Number(item.value[1]) }));
}
async function main() {
  const results = Object.fromEntries(await Promise.all(Object.entries(expressions).map(async ([name, expression]) => [name, await query(expression)])));
  if (!results.requests.length) throw Error('Prometheus has no request counters for this run');
  const count = rows => rows.reduce((sum, item) => sum + item.value, 0);
  const failures = count(results.failures_by_reason), requests = count(results.requests);
  const resets = ['request_counter_resets', 'failure_counter_resets', 'job_counter_resets'].some(name => count(results[name]) > 0);
  const logPath = path.join(root, 'measured.log');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const match = log.match(/thresholds on metrics '([^']+)' have been crossed/);
  const crossed = ['http_req_duration{phase:business,kind:read}', 'http_req_failed{phase:business}', 'checks{phase:business}'].filter(name => match?.[1].includes(name));
  const httpRequests = count(results.http_requests);
  const data = { run_id: metadata.run_id, measured_started_at: run.started_at, measured_finished_at: run.finished_at,
    source: 'Prometheus max_over_time of distinct counter series; final remote-write samples may omit events',
    approximate: true, counter_resets_detected: resets, requests, http_requests: httpRequests, http_counter_difference: httpRequests - requests, failures, business_failure_fraction: requests ? failures / requests : null,
    exact_full_run_percentiles_available: false, exact_k6_threshold_values_available: false, thresholds_crossed_in_k6_log: crossed, results };
  fs.writeFileSync(path.join(root, 'recovered-prometheus.json'), JSON.stringify(data, null, 2));
  const csv = ['role,endpoint,requests', ...results.requests_by_role_endpoint.map(item => `${item.labels.role || ''},${item.labels.endpoint || ''},${item.value}`)];
  fs.writeFileSync(path.join(root, 'recovered-endpoints.csv'), csv.join('\n') + '\n');
  const jobs = results.classifier_jobs_by_role_outcome.reduce((acc, item) => { const key = item.labels.outcome || 'unknown'; acc[key] = (acc[key] || 0) + item.value; return acc; }, {});
  const failuresByReason = Object.fromEntries(results.failures_by_reason.map(item => [item.labels.reason, item.value]));
  const lines = ['# Số liệu khôi phục từ Prometheus', '', `- Lượt chạy: ${metadata.run_id}`, `- Cửa sổ đo: ${run.started_at} đến ${run.finished_at}`,
    `- Số request nghiệp vụ xấp xỉ: ${requests}`, `- Counter HTTP k6 độc lập: ${httpRequests}; chênh lệch: ${httpRequests - requests}`,
    `- Số request lỗi xấp xỉ: ${failures} (${requests ? (100 * failures / requests).toFixed(2) : 'N/A'}%)`,
    `- Lỗi theo loại: ${JSON.stringify(failuresByReason)}`, `- Job nhận diện theo trạng thái: ${JSON.stringify(jobs)}`,
    `- Phát hiện reset counter: ${resets ? 'có' : 'không'}`, `- Nhóm ngưỡng k6 báo vượt trong log: ${crossed.join(', ') || 'không tìm thấy'}`, '',
    'Các số được khôi phục bằng max_over_time trên từng chuỗi counter Prometheus; mẫu remote-write cuối có thể thiếu sự kiện.',
    'k6 không ghi summary vì kiểm tra tuổi phiên chạy lại ở cuối lượt. Không thể suy ra chính xác p95/p99 toàn lượt hay các giá trị ngưỡng từ các percentile theo từng cửa sổ.',
    'Xem readiness.md để biết các giới hạn, timeseries.png và server-resources.png để xem diễn biến, recovered-endpoints.csv để xem request theo vai trò/endpoint.',
    'Không coi số liệu khôi phục này là summary gốc của k6.'];
  fs.writeFileSync(path.join(root, 'recovered-report.md'), lines.join('\n') + '\n');
  const files = fs.readdirSync(root).filter(name => name !== 'checksums.sha256' && fs.statSync(path.join(root, name)).isFile()).sort();
  fs.writeFileSync(path.join(root, 'checksums.sha256'), files.map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')}  ${name}`).join('\n') + '\n');
  console.log(`Recovered Prometheus counters to ${root}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
