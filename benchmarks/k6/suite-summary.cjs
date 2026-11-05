const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw Error('Usage: node suite-summary.cjs RESULTS_ROOT');
const rows = [];
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const folder = path.join(root, entry.name);
  if (!fs.existsSync(path.join(folder, 'analysis.json'))) continue;
  const analysis = JSON.parse(fs.readFileSync(path.join(folder, 'analysis.json')));
  const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json')));
  const readiness = JSON.parse(fs.readFileSync(path.join(folder, 'readiness.json')));
  const sample = metadata.step_vus ? analysis.stage_metrics?.find(item => item.stage === 'ramp_2') : null;
  rows.push({ case: entry.name, profile: metadata.profile, vus: metadata.step_vus || analysis.peak_vus,
    distribution: metadata.distribution, cache: metadata.cache_case, ready: readiness.ready,
    requests: sample?.requests ?? analysis.requests?.count, http_error_rate: sample?.http_error_rate ?? analysis.http_failed?.rate,
    checks_rate: sample?.checks_rate ?? analysis.checks?.rate,
    p95_ms: sample?.read_p95_ms ?? analysis.read_latency_ms?.['p(95)'], p99_ms: sample?.read_p99_ms ?? analysis.read_latency_ms?.['p(99)'],
    isolation_passes: analysis.isolation_checks?.passes, isolation_fails: analysis.isolation_checks?.fails,
    classifier_success: analysis.classifier_totals?.succeeded, classifier_attempted: analysis.classifier_totals?.attempted });
}
rows.sort((a, b) => a.case.localeCompare(b.case));
const headers = Object.keys(rows[0] || { case: null });
const cell = v => v == null ? '' : String(v).replaceAll('"', '""');
fs.writeFileSync(path.join(root, 'suite-summary.json'), JSON.stringify(rows, null, 2));
fs.writeFileSync(path.join(root, 'suite-summary.csv'), [headers.join(','), ...rows.map(row => headers.map(h => `"${cell(row[h])}"`).join(','))].join('\n') + '\n');
const columns = ['case', 'vus', 'distribution', 'cache', 'requests', 'http_error_rate', 'checks_rate', 'p95_ms', 'p99_ms', 'isolation_fails', 'ready'];
const table = ['| ' + columns.join(' | ') + ' |', '| ' + columns.map(() => '---').join(' | ') + ' |', ...rows.map(row => '| ' + columns.map(column => cell(row[column])).join(' | ') + ' |')];
fs.writeFileSync(path.join(root, 'suite-summary.md'), '# Kết quả benchmark theo trường hợp\n\nTỷ lệ được ghi dạng số thập phân; các mức nhỏ dùng mẫu trong 2 phút giữ tải. Chi tiết và readiness nằm trong thư mục từng trường hợp.\n\n' + table.join('\n') + '\n');
console.log(`Saved suite summary: ${rows.length} cases`);
