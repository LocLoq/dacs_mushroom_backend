const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { setTimeout: pause } = require('node:timers/promises');
const { validateRateLimits, validateSessions } = require('./validate-sessions.cjs');
const { knownHostKey, sshAuthentication } = require('./ssh-hosts.cjs');
const os = require('node:os');
const { generator, monitoring, queryRange } = require('./report-metadata.cjs');

const base = (process.env.BASE_URL || '').replace(/\/$/, '');
const sessionsPath = path.resolve(process.env.SESSIONS_PATH || '');
const image = path.resolve(process.env.BENCHMARK_IMAGE || '');
const k6 = process.env.K6_PATH || 'k6';
const output = path.resolve(process.env.RESULTS_DIR || '');
const mode = process.env.BENCHMARK_MODE || 'realistic';
const cacheCase = process.env.BENCHMARK_CACHE_CASE || 'cold';
if (!['off', 'cold', 'warm'].includes(cacheCase)) throw Error('Invalid BENCHMARK_CACHE_CASE');
if (!base || !process.env.SESSIONS_PATH || !process.env.BENCHMARK_IMAGE || !process.env.RESULTS_DIR) throw Error('Set BASE_URL, SESSIONS_PATH, BENCHMARK_IMAGE and RESULTS_DIR');
if (!['realistic', 'capacity'].includes(mode)) throw Error('BENCHMARK_MODE must be realistic or capacity');
if (mode === 'capacity' && process.env.BENCHMARK_CAPACITY_CONFIRMED !== '1') throw Error('Capacity mode requires BENCHMARK_CAPACITY_CONFIRMED=1');
const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
const measurementId = process.env.BENCHMARK_CASE_ID || sessions.runId;
if (!/^[a-z0-9_-]{4,80}$/.test(measurementId)) throw Error('Invalid BENCHMARK_CASE_ID');
const { smoke } = validateSessions(sessions, base);
const declaredRateLimits = validateRateLimits(process.env, { smoke, mode });
const imageHash = crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex');
if (sessions.imageSha256 !== imageHash) throw Error('BENCHMARK_IMAGE must match the photo validated during seed');
const sourceCount = process.env.BENCHMARK_SOURCE_IP_COUNT === undefined ? null : Number(process.env.BENCHMARK_SOURCE_IP_COUNT);
if ((!smoke && sourceCount === null) || (sourceCount !== null && (!Number.isSafeInteger(sourceCount) || sourceCount < 1))) throw Error('Set BENCHMARK_SOURCE_IP_COUNT to the number of source IPs visible to the server');
if (!smoke && (!process.env.SSH_HOST || !process.env.SSH_USER)) throw Error('Full benchmark requires SSH_HOST and SSH_USER for resource collection');
if (process.env.SSH_HOST) sshAuthentication();
if (mode === 'capacity' && !process.env.SSH_HOST) throw Error('Capacity mode requires SSH verification of the benchmark image');
if (!smoke && !process.env.K6_PROMETHEUS_RW_SERVER_URL) throw Error('Full benchmark requires Prometheus remote write');
if (fs.existsSync(output) && fs.readdirSync(output).length) throw Error('RESULTS_DIR must be a new or empty directory');
fs.mkdirSync(output, { recursive: true });
const script = path.join(__dirname, 'mixed-workload.js');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const python = process.env.BENCHMARK_PYTHON || 'python';
const prometheus = (process.env.BENCHMARK_PROMETHEUS_URL || 'http://127.0.0.1:9090').replace(/\/$/, '');
const grafana = (process.env.BENCHMARK_GRAFANA_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
if (!smoke && new URL(process.env.K6_PROMETHEUS_RW_SERVER_URL).origin !== new URL(prometheus).origin) throw Error('Prometheus query and remote-write URLs must have the same origin');
const metadata = { schema_version: 2, started_at: new Date().toISOString(), base_url: base, mode, run_id: sessions.runId, measurement_id: measurementId,
  profile: smoke ? 'smoke' : process.env.BENCHMARK_STEP_VUS ? 'steps-2000' : process.env.BENCHMARK_CALIBRATION_VUS === '100' ? 'calibration-100-vu' : 'full', roles: sessions.counts, source_ips: process.env.BENCHMARK_SOURCE_IPS || 'operating-system default',
  cache_case: cacheCase, distribution: process.env.BENCHMARK_DISTRIBUTION || 'uniform', step_vus: Number(process.env.BENCHMARK_STEP_VUS || 0), random_seed: Number(process.env.BENCHMARK_RANDOM_SEED || 1234567),
  source_ip_count_declared: sourceCount,
  rate_limits_declared: declaredRateLimits,
  generator: { platform: process.platform, node: process.version, k6: execFileSync(k6, ['version'], { encoding: 'utf8' }).trim(),
    local_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), script_sha256: hash(script),
    runner_sha256: hash(__filename), sampler_sha256: hash(path.join(__dirname, 'collect-resources.py')),
    seed_sha256: sessions.seedSha256, authenticate_sha256: sessions.authenticateSha256, image_sha256: imageHash,
    system: generator(python), image_size_bytes: fs.statSync(image).size, image_mime: sessions.imageMime }, runs: [] };
const save = () => fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
save();
let ssh, monitor, resourceFile, stopped = false, remoteArgs, generatorTimer, generatorIoTimer, activeChild, interrupted = false, finishing = false, ioPending = false, generatorIoSeen = false;
let monitorBuffer = '', safetyStop = null;
const checkSafety = require('./resource-safety.cjs').createResourceSafety();
function checkResourceSample(row) {
  safetyStop ||= checkSafety(row);
  if (safetyStop && activeChild) { metadata.safety_stop = safetyStop; activeChild.kill(); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; if (activeChild) activeChild.kill(); });
const generatorFile = fs.createWriteStream(path.join(output, 'generator-resources.ndjson'));
let previousCpu;
generatorTimer = setInterval(() => {
  const cpus = os.cpus(); const total = cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const delta = previousCpu && total - previousCpu.total;
  generatorFile.write(JSON.stringify({ timestamp: Date.now() / 1000, cpu_percent: delta ? 100 * (1 - (idle - previousCpu.idle) / delta) : null,
    memory_used_bytes: os.totalmem() - os.freemem(), memory_total_bytes: os.totalmem() }) + '\n');
  previousCpu = { total, idle };
}, 1000);
generatorIoTimer = setInterval(() => {
  if (ioPending || finishing) return;
  if (process.platform === 'linux') {
    try { generatorFile.write(JSON.stringify({ type: 'io', timestamp: Date.now() / 1000,
      network: fs.readFileSync('/proc/net/dev', 'utf8'), disk: fs.readFileSync('/proc/diskstats', 'utf8') }) + '\n'); generatorIoSeen = true; } catch (_) {}
  } else if (process.platform === 'win32') {
    ioPending = true;
    const script = "$ErrorActionPreference='Stop'; $n=Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | Select-Object BytesReceivedPersec,BytesSentPersec; $d=Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\" | Select-Object DiskReadBytesPersec,DiskWriteBytesPersec; if (!$n -or !$d) { exit 1 }; @{network=@($n);disk=@($d)} | ConvertTo-Json -Compress -Depth 3";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      ioPending = false;
      if (!error && !finishing) try { generatorFile.write(JSON.stringify({ type: 'io', timestamp: Date.now() / 1000, ...JSON.parse(stdout) }) + '\n'); generatorIoSeen = true; } catch (_) {}
    });
  }
}, 5000);
const sampler = fs.readFileSync(path.join(__dirname, 'collect-resources.py'), 'utf8');
function remote(command) {
  return new Promise((resolve, reject) => ssh.exec(command, (error, stream) => {
    if (error) return reject(error);
    let stdout = '', stderr = '';
    stream.on('data', data => stdout += data); stream.stderr.on('data', data => stderr += data);
    stream.on('close', code => code === 0 ? resolve(stdout) : reject(Error(`SSH sampler exit ${code}: ${stderr}`)));
    stream.end(sampler);
  }));
}
async function startSampler() {
  if (!process.env.SSH_HOST) { metadata.sampler = 'disabled'; save(); return; }
  const project = process.env.BENCHMARK_COMPOSE_PROJECT || 'dacs-mushroom';
  const repo = process.env.BENCHMARK_REMOTE_REPO || '/home/loql/dacs_mushroom_backend';
  if (!/^[a-zA-Z0-9_-]+$/.test(project) || !/^\/[a-zA-Z0-9_./-]+$/.test(repo)) throw Error('Invalid SSH sampler project or repository path');
  const toolRoot = process.env.BENCHMARK_TOOLS || path.join(process.env.TEMP || '.', 'dacs-benchmark-tools');
  const { Client } = createRequire(path.join(toolRoot, 'package.json'))('ssh2');
  const port = Number(process.env.SSH_PORT || 22);
  const key = knownHostKey(fs.readFileSync(path.join(toolRoot, 'known_hosts'), 'utf8'), process.env.SSH_HOST, port);
  if (!key) throw Error('Verify and pin SSH host key in benchmark known_hosts');
  metadata.generator.host_key_sha256 = crypto.createHash('sha256').update(key).digest('base64');
  ssh = new Client();
  await new Promise((resolve, reject) => ssh.once('ready', resolve).once('error', reject).connect({ host: process.env.SSH_HOST,
    port, username: process.env.SSH_USER, ...sshAuthentication(),
    hostVerifier: actual => actual.equals(key), readyTimeout: 15000, keepaliveInterval: 10000 }));
  const args = `--project ${project} --repo ${repo}`; remoteArgs = args;
  const before = Date.now();
  metadata.server = JSON.parse(await remote(`exec python3 -u - --metadata ${args}`));
  const api = metadata.server.containers.filter(item => item.service === 'api');
  if (api.length !== 1) throw Error('Expected one API container for mode verification');
  let effective;
  try { effective = JSON.parse(api[0].versions.runtime.stdout); } catch (_) { throw Error('Cannot verify API runtime mode'); }
  if (effective.mode !== (mode === 'capacity' ? 'benchmark' : 'production')) throw Error('Server image mode does not match benchmark mode');
  metadata.effective_api = effective;
  const cacheEnabled = api[0].config.CACHE_ENABLED === 'true';
  if (cacheEnabled !== (cacheCase !== 'off')) throw Error('Running API cache mode does not match BENCHMARK_CACHE_CASE');
  metadata.cache_effective = { enabled: cacheEnabled, namespace: api[0].config.CACHE_NAMESPACE || 'mushroom:public:v1' };
  metadata.rate_limits_effective = mode === 'capacity' ? { enabled: false, api: null, classifier: null, window_ms: null } : {
    enabled: true, api: Number(api[0].config.API_RATE_LIMIT_MAX || 300), classifier: Number(api[0].config.CLASSIFIER_RATE_LIMIT_MAX || 10),
    window_ms: Number(api[0].config.RATE_LIMIT_WINDOW_MS || 60000) };
  if (mode === 'realistic') {
    for (const [field, env, fallback] of [['api', 'API_RATE_LIMIT_MAX', 300], ['classifier', 'CLASSIFIER_RATE_LIMIT_MAX', 10], ['window_ms', 'RATE_LIMIT_WINDOW_MS', 60000]]) {
      const actual = Number(api[0].config[env] || fallback);
      if (declaredRateLimits[field] !== null && declaredRateLimits[field] !== actual) throw Error(`Declared ${env} differs from running API`);
    }
  }
  const after = Date.now();
  metadata.clock_offset_ms = metadata.server.timestamp * 1000 - (before + after) / 2;
  metadata.clock_uncertainty_ms = (after - before) / 2;
  resourceFile = fs.createWriteStream(path.join(output, 'resources.ndjson'));
  await new Promise((resolve, reject) => ssh.exec(`exec python3 -u - ${args}`, (error, stream) => {
    if (error) return reject(error);
    monitor = stream; let first = '', ready = false;
    stream.on('data', chunk => {
      resourceFile.write(chunk); monitorBuffer += chunk.toString();
      const lines = monitorBuffer.split('\n'); monitorBuffer = lines.pop();
      for (const line of lines) try { checkResourceSample(JSON.parse(line)); } catch (_) {}
      if (!ready) { first += chunk; if (first.includes('\n')) { ready = true; resolve(); } }
    });
    stream.stderr.on('data', chunk => process.stderr.write(`Sampler: ${chunk}`));
    stream.on('close', () => { stopped = true; if (!ready) reject(Error('Resource sampler failed to start')); });
    stream.end(sampler);
  }));
  metadata.sampler = 'ssh'; metadata.baseline_started_at = new Date().toISOString(); save();
  await pause(15000);
  metadata.baseline_finished_at = new Date().toISOString(); save();
}
async function run(phase) {
  if (interrupted) throw Error('Benchmark interrupted');
  if (safetyStop) throw Error(safetyStop);
  if (metadata.sampler === 'ssh' && stopped) throw Error('Resource sampler stopped before test completion');
  if (hash(script) !== metadata.generator.script_sha256) throw Error('Benchmark script changed during the run; start a new results directory');
  const record = { id: phase, started_at: new Date().toISOString() }; metadata.runs.push(record); save();
  const log = fs.createWriteStream(path.join(output, `${phase}.log`));
  const env = { ...process.env, BASE_URL: base, SESSIONS_PATH: sessionsPath, BENCHMARK_IMAGE: image,
    BENCHMARK_PHASE: phase, SUMMARY_PATH: path.join(output, `${phase}.summary.json`), K6_NO_COLOR: 'true', K6_NO_USAGE_REPORT: 'true',
    K6_PROMETHEUS_RW_TREND_STATS: 'avg,med,p(95),p(99)' };
  if (phase === 'warmup' || smoke || process.env.BENCHMARK_STEP_VUS) env.SESSION_MS = '20000';
  delete env.SSH_PASSWORD; delete env.SSH_PRIVATE_KEY; delete env.SSH_PASSPHRASE; delete env.SSH_AUTH_SOCK; delete env.BENCHMARK_PASSWORD;
  const args = ['run', '--quiet', '--new-machine-readable-summary=false'];
  if (process.env.BENCHMARK_SOURCE_IPS) args.push('--local-ips', process.env.BENCHMARK_SOURCE_IPS);
  if (process.env.K6_PROMETHEUS_RW_SERVER_URL) args.push('--out', 'experimental-prometheus-rw');
  args.push(script);
  console.log(`Starting ${phase}`);
  try {
    record.exit_code = await new Promise((resolve, reject) => {
      const child = spawn(k6, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); activeChild = child;
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.on('error', reject); child.on('close', code => { activeChild = null; resolve(code); });
    });
  } finally { log.end(); record.finished_at = new Date().toISOString(); save(); }
  if (hash(script) !== metadata.generator.script_sha256) throw Error('Benchmark script changed during measurement; results are invalid');
  if (safetyStop) throw Error(safetyStop);
  if (record.exit_code !== 0 && (phase !== 'measured' || record.exit_code !== 99)) throw Error(`${phase} failed; inspect ${phase}.log`);
  console.log(`Finished ${phase}: exit ${record.exit_code}`);
}
async function sshCommand(command) {
  return new Promise((resolve, reject) => ssh.exec(command, (error, stream) => {
    if (error) return reject(error);
    let output = '', stderr = '';
    stream.on('data', chunk => output += chunk); stream.stderr.on('data', chunk => stderr += chunk);
    stream.on('close', code => code === 0 ? resolve(output.trim()) : reject(Error(`Cache preparation failed: ${stderr}`)));
  }));
}
async function prepareCache() {
  if (cacheCase === 'off') { metadata.cache_preparation = { mode: 'off' }; save(); return; }
  if (!ssh) throw Error('Cache preparation requires SSH');
  const namespace = metadata.cache_effective.namespace, project = process.env.BENCHMARK_COMPOSE_PROJECT;
  if (!/^[a-zA-Z0-9:_-]+$/.test(namespace) || !/^[a-zA-Z0-9_-]+$/.test(project || '')) throw Error('Unsafe cache namespace or project');
  for (const group of ['species', 'gallery', 'progress']) {
    const result = await sshCommand(`docker exec ${project}-redis-cache-1 redis-cli SET ${namespace}:epoch:${group} ${crypto.randomUUID()}`);
    if (result !== 'OK') throw Error('Unable to rotate cache namespace');
  }
  metadata.cache_preparation = { mode: cacheCase, reset_at: new Date().toISOString() };
  if (cacheCase === 'warm') {
    const speciesPaths = (sessions.species || []).flatMap(s => [`/api/mushroom-species/${s.id}`, `/api/mushroom-species/${s.id}/images`]);
    const searchPaths = ['', ...(sessions.searchTerms || [])].flatMap(term => (term && !['Benchmark', 'Family'].includes(term) ? [1] : [1, 2, 3, 4]).flatMap(page => [10, 20, 50].map(limit => `/api/mushroom-species?page=${page}&limit=${limit}${term ? `&search=${encodeURIComponent(term)}` : ''}`)));
    const progressPaths = sessions.batches.map(b => `/api/public/cultivation-batches/${encodeURIComponent(b.code)}/growth-progress/current`);
    const paths = [...speciesPaths, ...searchPaths, ...progressPaths];
    let cursor = 0, failures = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (cursor < paths.length) {
      const p = paths[cursor++]; try { const response = await fetch(base + p, { signal: AbortSignal.timeout(30000) }); await response.arrayBuffer(); if (!response.ok) failures++; } catch (_) { failures++; }
    } }));
    if (failures) throw Error(`Cache warmup failed for ${failures} requests`);
    let hits = 0; const sample = [...speciesPaths.slice(0, 2), ...searchPaths.slice(-4), ...progressPaths.slice(0, 4)];
    for (const p of sample) { const response = await fetch(base + p, { signal: AbortSignal.timeout(30000) }); await response.arrayBuffer(); if (response.ok && response.headers.get('x-cache') === 'HIT') hits++; }
    metadata.cache_preparation = { ...metadata.cache_preparation, paths: paths.length, verification_requests: sample.length, hits, completed_at: new Date().toISOString() };
    if (!sample.length || hits !== sample.length) throw Error('Cache warmup verification failed');
  }
  save();
}
async function main() {
  metadata.monitoring = await monitoring(prometheus, grafana); save();
  if (!smoke && (metadata.monitoring.prometheus.status !== 'ok' || metadata.monitoring.grafana.status !== 'ok')) throw Error('Full benchmark requires healthy Prometheus and Grafana');
  if (!smoke) {
    const writeUrl = new URL(process.env.K6_PROMETHEUS_RW_SERVER_URL);
    if (writeUrl.username || writeUrl.password || writeUrl.search || writeUrl.hash) throw Error('Prometheus remote-write URL must not contain credentials or query');
    const response = await fetch(writeUrl, { method: 'POST', headers: { 'Content-Encoding': 'snappy', 'Content-Type': 'application/x-protobuf' }, body: new Uint8Array(), signal: AbortSignal.timeout(5000) });
    metadata.monitoring.remote_write_probe = { status: response.status, observed_at: new Date().toISOString() }; save();
    if (![200, 202, 204, 400].includes(response.status)) throw Error(`Prometheus remote-write receiver unavailable (HTTP ${response.status})`);
  }
  await startSampler();
  if (!smoke) {
    if (!generatorIoSeen) throw Error('Cannot collect generator network and disk I/O; check platform permissions');
    if (metadata.generator.system.python.status !== 'ok') throw Error('Full benchmark requires Python for automatic analysis');
    if (metadata.generator.system.python_packages.status !== 'ok') throw Error('Cannot inventory Python packages');
    let packages;
    try { packages = JSON.parse(metadata.generator.system.python_packages.value); } catch (_) { throw Error('Invalid Python package inventory'); }
    if (!packages.some(item => item.name.toLowerCase() === 'matplotlib')) throw Error('Full benchmark requires Matplotlib for report charts');
    for (const field of ['os_release', 'kernel', 'lscpu', 'disk', 'compose_version']) {
      const value = metadata.server[field];
      if (!value || value.exit_code !== 0 || !value.stdout) throw Error(`Missing server system metadata: ${field}`);
    }
    if (!metadata.server.cpu_count || !metadata.server.memory?.MemTotal || !metadata.server.docker_version?.Version) throw Error('Missing server CPU, RAM or Docker version');
    const found = new Set(metadata.server.containers.map(item => item.service));
    for (const name of ['api', 'db', 'redis', 'redis-cache', 'classifier', 'classifier-worker']) if (!found.has(name)) throw Error(`Missing required service metadata: ${name}`);
    for (const container of metadata.server.containers.filter(item => ['api', 'db', 'redis', 'redis-cache', 'classifier', 'classifier-worker'].includes(item.service))) {
      for (const [name, version] of Object.entries(container.versions)) if (version.exit_code !== 0 || !version.stdout) throw Error(`Missing version metadata: ${container.service}/${name}`);
    }
  }
  await run('preflight');
  await run('warmup');
  await prepareCache();
  await run('security');
  await run('measured');
  if (metadata.sampler === 'ssh' && stopped) throw Error('Resource sampler stopped before measurements finished');
  if (ssh && remoteArgs) metadata.server_after = JSON.parse(await remote(`exec python3 -u - --metadata ${remoteArgs}`));
  metadata.finished_at = new Date().toISOString(); save();
  if (metadata.runs.at(-1).exit_code === 99) process.exitCode = 99;
}
async function finish(error) {
  finishing = true;
  if (error) { metadata.error = error.message; console.error(error.message); process.exitCode = 1; }
  metadata.finished_at ||= new Date().toISOString();
  metadata.incomplete = !!error;
  if (monitor) { monitor.removeAllListeners('data'); monitor.signal('TERM'); monitor.close(); }
  if (ssh) ssh.end();
  clearInterval(generatorTimer); clearInterval(generatorIoTimer);
  await Promise.all([new Promise(resolve => generatorFile.end(resolve)), ...(resourceFile ? [new Promise(resolve => resourceFile.end(resolve))] : [])]);
  const measured = metadata.runs.find(row => row.id === 'measured');
  if (measured?.finished_at && metadata.monitoring?.prometheus?.status === 'ok') {
    const start = Date.parse(measured.started_at) / 1000, end = Date.parse(measured.finished_at) / 1000;
    const selector = `benchmark_run="${measurementId}",test_phase="measured"`;
    const queries = { vus: `k6_vus{${selector}}`, rps: `sum(rate(k6_business_requests_total{${selector}}[1m]))`,
      failures: `sum(rate(k6_business_failures_total{${selector}}[1m]))`, latency_p95: `max(k6_http_req_duration_p95{${selector},phase="business"})`,
      classifier: `sum by (outcome) (rate(k6_classifier_jobs_total{${selector}}[1m]))`,
      input_coverage: `sum by (dimension,slot) (k6_input_coverage_total{${selector}})` };
    const series = Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([name, query]) => {
      try { return [name, await queryRange(prometheus, query, start, end)]; }
      catch (failure) { return [name, { error: failure.message }]; }
    })));
    fs.writeFileSync(path.join(output, 'timeseries.json'), JSON.stringify(series, null, 2));
  }
  save();
  const analysis = spawn(python, [path.join(__dirname, 'analyze-results.py'), output], { stdio: 'inherit', windowsHide: true });
  const succeeded = await new Promise(resolve => { analysis.on('error', e => { console.error(`Analyzer unavailable: ${e.message}`); resolve(false); }); analysis.on('close', code => resolve(code === 0)); });
  if (!succeeded) {
    process.exitCode = 1;
    const readiness = { schema_version: 2, ready: false, performance_passed: null, incomplete: true, missing: ['Không chạy được công cụ phân tích Python; xem metadata và log.'] };
    fs.writeFileSync(path.join(output, 'readiness.json'), JSON.stringify(readiness, null, 2));
    fs.writeFileSync(path.join(output, 'readiness.md'), '# Kiểm tra dữ liệu báo cáo\n\nChưa đủ dữ liệu: không chạy được công cụ phân tích Python.\n');
    fs.writeFileSync(path.join(output, 'report.md'), '# Báo cáo benchmark chưa hoàn tất\n\nKhông chạy được công cụ phân tích Python. Xem metadata.json và log để kiểm tra.\n');
    fs.writeFileSync(path.join(output, 'versions.json'), JSON.stringify({ schema_version: 2, generator: metadata.generator, monitoring: metadata.monitoring }, null, 2));
    fs.writeFileSync(path.join(output, 'environment.json'), JSON.stringify({ schema_version: 2, server_before: metadata.server, server_after: metadata.server_after }, null, 2));
    const sums = fs.readdirSync(output).filter(name => name !== 'checksums.sha256' && fs.statSync(path.join(output, name)).isFile()).sort().map(name => `${hash(path.join(output, name))}  ${name}`);
    fs.writeFileSync(path.join(output, 'checksums.sha256'), sums.join('\n') + '\n');
  }
}
main().then(() => finish(), error => finish(error)).catch(error => { console.error(error.message); process.exitCode = 1; });
