// SSH dependencies live outside the repository. Credentials come only from environment variables.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const tools = process.env.BENCHMARK_TOOLS || path.join(process.env.TEMP, 'dacs-benchmark-tools');
const { Client } = createRequire(path.join(tools, 'package.json'))('ssh2');
const k6 = process.env.K6_PATH || path.join(tools, 'k6-v2.3.0-windows-amd64', 'k6.exe');
const output = path.resolve(process.env.RESULTS_DIR || 'benchmarks/results/2026-10-01-local');
fs.mkdirSync(output, { recursive: true });
const metadataPath = path.join(output, 'metadata.json');
if (fs.existsSync(metadataPath)) throw new Error('Choose a new RESULTS_DIR to preserve existing measurements');
if (!process.env.SSH_PASSWORD || !process.env.SSH_USER || !process.env.TEST_PASSWORD) {
  throw new Error('Set SSH_USER, SSH_PASSWORD, TEST_USER, TEST_PASSWORD');
}
const script = fs.readFileSync(path.join(__dirname, 'collect-resources.py'), 'utf8');
const ssh = new Client();
const knownHosts = fs.readFileSync(path.join(tools, 'known_hosts'), 'utf8').split(/\r?\n/);
const host = process.env.SSH_HOST || '172.23.87.58';
const knownKey = knownHosts.find(line => line.startsWith(`${host} `))?.split(/\s+/)[2];
if (!knownKey) throw new Error('Verify SSH host key with OpenSSH first');
const hostKey = Buffer.from(knownKey, 'base64');
const metadata = { started_at: new Date().toISOString(), timezone: 'Asia/Ho_Chi_Minh',
  base_url: process.env.BASE_URL || 'http://172.23.87.58:8080',
  generator: { platform: process.platform, node: process.version,
    k6: execFileSync(k6, ['version'], { encoding: 'utf8' }).trim(),
    local_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    script_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'list-batches.js'))).digest('hex'),
    host_key_sha256: crypto.createHash('sha256').update(hostKey).digest('base64') },
  protocol: { vus: [10, 25, 50, 100], repeats: 3, duration_seconds: 60, think_time_seconds: 1,
    baseline_seconds: 15, warmup_vus: 1, warmup_seconds: 60, cooldown_seconds: 5 }, runs: [] };
let monitor;
let resourceFile;
let samplerStopped = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function save() { fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2)); }
function remote(command, payload) {
  return new Promise((resolve, reject) => ssh.exec(command, (error, stream) => {
    if (error) return reject(error);
    let stdout = '', stderr = '';
    stream.on('data', chunk => stdout += chunk);
    stream.stderr.on('data', chunk => stderr += chunk);
    stream.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`SSH command exit ${code}: ${stderr}`)));
    stream.end(payload);
  }));
}
async function run(id, vus, duration) {
  if (samplerStopped) throw new Error('Resource sampler stopped before benchmark completion');
  const record = { id, vus, duration_seconds: duration, started_at: new Date().toISOString(),
    script_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'list-batches.js'))).digest('hex') };
  metadata.runs.push(record); save();
  console.log(`START ${id} ${vus} VU ${duration}s ${record.started_at}`);
  const log = fs.createWriteStream(path.join(output, `${id}.log`));
  try {
    record.exit_code = await new Promise((resolve, reject) => {
      const childEnv = { ...process.env, BASE_URL: metadata.base_url, VUS: String(vus), DURATION: `${duration}s`,
          SUMMARY_PATH: path.join(output, `${id}.summary.json`), THINK_TIME: '1',
          K6_NO_USAGE_REPORT: 'true', K6_NO_COLOR: 'true' };
      delete childEnv.SSH_PASSWORD;
      const child = spawn(k6, ['run', '--quiet', '--new-machine-readable-summary=false', path.join(__dirname, 'list-batches.js')], {
        env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.on('error', reject); child.on('close', resolve);
    });
  } finally { log.end(); record.finished_at = new Date().toISOString(); save(); }
  if (![0, 99].includes(record.exit_code)) throw new Error(`${id} execution failed, see log`);
  console.log(`DONE ${id} exit=${record.exit_code} ${record.finished_at}`);
}

async function main() {
  await new Promise((resolve, reject) => {
    ssh.once('ready', resolve).once('error', reject).connect({
      host, port: Number(process.env.SSH_PORT || 22), username: process.env.SSH_USER,
      password: process.env.SSH_PASSWORD, readyTimeout: 15000,
      keepaliveInterval: 10000, hostVerifier: key => key.equals(hostKey),
    });
  });
  const localBefore = Date.now();
  metadata.server = JSON.parse(await remote('exec python3 -u - --metadata', script));
  const localAfter = Date.now();
  metadata.clock_offset_ms = metadata.server.timestamp * 1000 - (localBefore + localAfter) / 2;
  metadata.clock_uncertainty_ms = (localAfter - localBefore) / 2;
  save();
  resourceFile = fs.createWriteStream(path.join(output, 'resources.ndjson'));
  await new Promise((resolve, reject) => ssh.exec('exec python3 -u -', (error, stream) => {
    if (error) return reject(error);
    monitor = stream;
    let first = '', ready = false;
    stream.on('data', chunk => {
      resourceFile.write(chunk);
      if (!ready) {
        first += chunk;
        if (first.includes('\n')) { ready = true; resolve(); }
      }
    });
    stream.stderr.on('data', chunk => console.error(`MONITOR: ${chunk}`));
    stream.on('close', () => { samplerStopped = true; if (!ready) reject(new Error('Resource monitor did not start')); });
    stream.end(script);
  }));
  console.log('SSH resource sampler ready; collecting 15s idle baseline');
  metadata.baseline_started_at = new Date().toISOString(); save();
  await pause(15000);
  metadata.baseline_finished_at = new Date().toISOString(); save();
  await run('warmup', 1, 60);
  // A short 1-VU smoke run verifies the exact k6 binary and summary schema first.
  if (process.env.SMOKE_ONLY === '1') return;
  for (const vus of metadata.protocol.vus) {
    for (let repeat = 1; repeat <= metadata.protocol.repeats; repeat++) {
      await pause(5000);
      await run(`vu${vus}-r${repeat}`, vus, 60);
    }
  }
  await pause(5000);
  if (samplerStopped) throw new Error('Resource sampler stopped before final measurements');
  metadata.server_after = JSON.parse(await remote('exec python3 -u - --metadata', script));
  metadata.finished_at = new Date().toISOString(); save();
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  if (monitor) { monitor.signal('TERM'); monitor.close(); }
  ssh.end();
  if (resourceFile) resourceFile.end();
});
