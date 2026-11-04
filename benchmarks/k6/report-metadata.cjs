const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function command(program, args) {
  try { return { status: 'ok', value: execFileSync(program, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (error) { return { status: 'unavailable', error: error.code || 'command_failed' }; }
}
function generator(python) {
  const cpus = os.cpus();
  let disk = null, limits = null;
  try { const info = fs.statfsSync(process.cwd()); disk = { block_size: info.bsize, blocks: info.blocks, free_blocks: info.bavail }; } catch (_) {}
  if (process.platform === 'linux') try { limits = fs.readFileSync('/proc/self/limits', 'utf8'); } catch (_) {}
  return { observed_at: new Date().toISOString(), source: 'node:os and local commands',
    platform: os.platform(), release: os.release(), architecture: os.arch(), cpu_model: cpus[0]?.model,
    cpu_count: cpus.length, total_memory_bytes: os.totalmem(), filesystem: disk,
    process_limits: limits || { status: 'not_available', platform: process.platform },
    node: process.version, npm: process.platform === 'win32' ? command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm --version']) : command('npm', ['--version']), python: command(python, ['--version']),
    python_packages: command(python, ['-m', 'pip', 'list', '--format=json']),
    docker: command('docker', ['version', '--format', '{{json .}}']),
    compose: command('docker', ['compose', 'version']),
    git_status: command('git', ['status', '--short']) };
}
async function readJson(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw Error('Monitoring URL must be HTTP(S) without credentials or query');
  const response = await fetch(parsed, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error(`Monitoring returned HTTP ${response.status}`);
  return response.json();
}
async function monitoring(prometheus, grafana) {
  const result = { observed_at: new Date().toISOString(), source: 'monitoring health APIs' };
  for (const [key, url] of Object.entries({ prometheus: `${prometheus}/api/v1/status/buildinfo`, grafana: `${grafana}/api/health` })) {
    try {
      const response = await readJson(url);
      const data = key === 'prometheus' ? response.data : response;
      if (!data?.version) throw Error(`${key} response has no version`);
      const fields = key === 'prometheus' ? ['version', 'revision', 'branch', 'goVersion'] : ['version', 'commit', 'database'];
      result[key] = { status: 'ok', value: Object.fromEntries(fields.filter(field => data?.[field] !== undefined).map(field => [field, data[field]])) };
    }
    catch (error) { result[key] = { status: 'unavailable', error: error.message }; }
  }
  return result;
}
async function queryRange(base, query, start, end, step = 5) {
  const url = new URL('/api/v1/query_range', base);
  url.search = new URLSearchParams({ query, start: String(start), end: String(end), step: String(step) }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Prometheus query HTTP ${response.status}`);
  const data = await response.json();
  if (data.status !== 'success') throw Error('Prometheus query failed');
  return data.data;
}
module.exports = { command, generator, monitoring, queryRange };
