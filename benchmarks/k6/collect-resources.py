"""Read-only Linux/Docker sampler. Send over SSH stdin; no server files needed."""
import datetime
import http.client
import json
import os
import socket
import subprocess
import sys
import time

def option(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

project = option('--project', 'dacs-mushroom')
repo = option('--repo', '/home/loql/dacs_mushroom_backend')
duration = int(option('--duration', '0'))


class DockerConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=5)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def docker(path):
    connection = DockerConnection()
    try:
        connection.request('GET', path)
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError('Docker HTTP %s' % response.status)
        return json.loads(response.read())
    finally:
        connection.close()


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def host_cpu():
    with open('/proc/stat') as source:
        values = list(map(int, source.readline().split()[1:9]))
    return sum(values), values[3] + values[4], values[4], values[7]


def memory():
    with open('/proc/meminfo') as source:
        values = {line.split(':')[0]: int(line.split()[1]) * 1024 for line in source}
    return {name: values[name] for name in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree')}

def host_io():
    result = {'network': {}, 'disks': {}}
    with open('/proc/net/dev') as source:
        for line in list(source)[2:]:
            name, counters = line.split(':', 1)
            values = counters.split()
            result['network'][name.strip()] = {'rx_bytes': int(values[0]), 'tx_bytes': int(values[8])}
    with open('/proc/diskstats') as source:
        for line in source:
            values = line.split()
            if len(values) >= 14:
                result['disks'][values[2]] = {'read_sectors': int(values[5]), 'written_sectors': int(values[9])}
    return result


if '--metadata' in sys.argv:
    def command(*args):
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=30)
            return {'exit_code': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()[:500]}
        except (OSError, subprocess.TimeoutExpired) as error:
            return {'exit_code': None, 'stdout': '', 'stderr': str(error)}
    running = docker('/containers/json')
    services = []
    for entry in running:
        if entry.get('Labels', {}).get('com.docker.compose.project') != project:
            continue
        info = docker('/containers/%s/json' % entry['Id'])
        service = entry.get('Labels', {}).get('com.docker.compose.service')
        image = docker('/images/%s/json' % info['Image'])
        env = dict(item.split('=', 1) for item in info['Config'].get('Env', []) if '=' in item)
        allowed = ('RATE_LIMIT_WINDOW_MS', 'API_RATE_LIMIT_MAX', 'CLASSIFIER_RATE_LIMIT_MAX', 'TRUST_PROXY',
                   'CLASSIFIER_MAX_CONCURRENCY', 'CLASSIFIER_DEVICE', 'CLASSIFIER_TIMEOUT_MS',
                   'CLASSIFIER_JOB_ATTEMPTS', 'CLASSIFIER_RETRY_BACKOFF_MS', 'CLASSIFIER_QUEUE_WAIT_MS',
                   'CLASSIFIER_PROCESSING_TIMEOUT_MS', 'CLASSIFIER_WORKER_CONCURRENCY',
                   'CLASSIFIER_ADMISSION_LIMIT', 'CLASSIFIER_TORCH_THREADS', 'DATABASE_POOL_SIZE', 'NODE_ENV')
        version = {}
        if service in ('api', 'classifier-worker'):
            version['runtime'] = command('docker', 'exec', entry['Id'], 'node', '-e',
                "const fs=require('fs');const s=process.argv[1]==='api'?'api':'worker';let r={};try{r=JSON.parse(fs.readFileSync('/tmp/classifier-runtime-'+s+'.json'))}catch(e){};console.log(JSON.stringify({node:process.version,mode:require('./config/runtime-mode.cjs').runtimeMode(),pool:r.pool_limit,worker_concurrency:Number(process.env.CLASSIFIER_WORKER_CONCURRENCY||1),sample_timestamp:r.timestamp}))", service)
            version['npm'] = command('docker', 'exec', entry['Id'], 'npm', '--version')
            version['node_dependencies'] = command('docker', 'exec', entry['Id'], 'node', '-e',
                "const cp=require('child_process');let out;try{out=cp.execFileSync('npm',['ls','--all','--json'],{encoding:'utf8',maxBuffer:25000000,stdio:['ignore','pipe','pipe']})}catch(e){out=e.stdout||''};try{const j=JSON.parse(out);function f(x){return {version:x.version,dependencies:Object.fromEntries(Object.entries(x.dependencies||{}).map(([k,v])=>[k,f(v)]))}};console.log(JSON.stringify(f(j)))}catch(e){process.exit(1)}")
            version['source_hash'] = command('docker', 'exec', entry['Id'], 'node', '-e',
                "const fs=require('fs'),crypto=require('crypto'),h=crypto.createHash('sha256');function walk(p){for(const n of fs.readdirSync(p).sort()){const f=p+'/'+n;fs.statSync(f).isDirectory()?walk(f):h.update(f).update(fs.readFileSync(f))}};for(const p of ['config','routes','services','middlewares','queues','jobs'])walk(p);for(const p of ['server.cjs','classifier-worker.cjs'])h.update(fs.readFileSync(p));console.log(h.digest('hex'))")
            version['database_runtime'] = command('docker', 'exec', entry['Id'], 'node', '-e',
                "const m=require('mariadb');(async()=>{let c=await m.createConnection({host:process.env.DATABASE_HOST,user:process.env.DATABASE_USER,password:process.env.DATABASE_PASSWORD,database:process.env.DATABASE_NAME,port:Number(process.env.DATABASE_PORT||3306)});let r=await c.query('SELECT VERSION() AS version, @@max_connections AS max_connections, @@innodb_buffer_pool_size AS innodb_buffer_pool_size, @@collation_server AS collation_server');console.log(JSON.stringify(r[0],(_,v)=>typeof v==='bigint'?v.toString():v));await c.end()})().catch(()=>process.exit(1))")
        elif service == 'classifier':
            version['python'] = command('docker', 'exec', entry['Id'], 'python', '--version')
            version['python_dependencies'] = command('docker', 'exec', entry['Id'], 'python', '-m', 'pip', 'list', '--format=json')
            version['model_hashes'] = command('docker', 'exec', entry['Id'], 'python', '-c',
                "import os,hashlib,json,pathlib; base=pathlib.Path('/app/helper/mushroom_classifier'); names={'model':('MODEL_PATH','nammushroom_efficientnet_b0.pth'),'labels':('LABELS_PATH','labels.txt'),'catalog':('MUSHROOM_CATALOG_PATH','mushroom.json')}; paths={k:base/os.getenv(e,n) for k,(e,n) in names.items()}; print(json.dumps({k:hashlib.sha256(p.read_bytes()).hexdigest() for k,p in paths.items()}))")
            version['model_runtime'] = command('docker', 'exec', entry['Id'], 'python', '-c',
                "import torch,json,os,pathlib,urllib.request; p=pathlib.Path('/app/helper/mushroom_classifier')/os.getenv('LABELS_PATH','labels.txt'); labels=[s for s in p.read_text().splitlines() if s.strip() and not s.strip().startswith('#')]; health=json.load(urllib.request.urlopen('http://127.0.0.1:8001/health',timeout=5)); print(json.dumps({'architecture':'efficientnet_b0','class_count':len(labels),'requested_device':os.getenv('CLASSIFIER_DEVICE','auto'),'cuda_available':torch.cuda.is_available(),'cuda':torch.version.cuda,'cudnn':torch.backends.cudnn.version(),'torch':torch.__version__,'threads':health['threads']}))")
        elif service == 'db':
            version['server'] = command('docker', 'exec', entry['Id'], 'mariadb', '--version')
        elif service == 'redis':
            version['server'] = command('docker', 'exec', entry['Id'], 'redis-cli', 'INFO', 'server')
        version['os_packages'] = command('docker', 'exec', entry['Id'], 'sh', '-c', 'if command -v dpkg-query >/dev/null; then dpkg-query -W; elif command -v apk >/dev/null; then apk info -v; else exit 1; fi')
        services.append({'name': info['Name'], 'service': service, 'image': info['Config']['Image'],
                         'image_id': info['Image'], 'repo_digests': image.get('RepoDigests') or [],
                         'state': {'status': info['State'].get('Status'), 'oom_killed': info['State'].get('OOMKilled'),
                                   'started_at': info['State'].get('StartedAt'), 'restart_count': info.get('RestartCount')},
                         'config': {key: env[key] for key in allowed if key in env}, 'versions': version,
                         'limits': {key: info['HostConfig'].get(key) for key in
                                    ('Memory', 'MemorySwap', 'NanoCpus', 'CpuQuota', 'CpuPeriod', 'CpusetCpus')}})
    emit({'timestamp': time.time(), 'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'hostname': socket.gethostname(), 'cpu_count': os.cpu_count(), 'memory': memory(),
          'os_release': command('cat', '/etc/os-release'), 'kernel': command('uname', '-a'),
          'lscpu': command('lscpu'), 'disk': command('df', '-B1', '/'),
          'docker_version': docker('/version'), 'compose_version': command('docker', 'compose', 'version'),
          'remote_commit': command('git', '-C', repo, 'rev-parse', 'HEAD'),
          'remote_git_status': command('git', '-C', repo, 'status', '--short'),
          'process_limits': command('cat', '/proc/self/limits'),
          'containers': services})
    sys.exit(0)

containers = [c for c in docker('/containers/json')
              if c.get('Labels', {}).get('com.docker.compose.project') == project]
if not containers:
    raise RuntimeError('No running containers in Compose project %s' % project)
emit({'type': 'collector', 'timestamp': time.time(), 'interval_seconds': 1,
      'cpu_count': os.cpu_count(), 'containers': [c['Names'][0].lstrip('/') for c in containers],
      'cpu_definition': 'host: 100*(delta total - delta idle - delta iowait)/delta total; container: Docker CPU delta normalized to one core',
      'memory_definition': 'host: MemTotal - MemAvailable; container working set: memory_stats.usage - inactive_file (Docker CLI convention)'})
previous_host = host_cpu()
previous_containers = {}
last_runtime = 0
deadline = time.monotonic()
expires = deadline + duration if duration > 0 else float('inf')
while time.monotonic() < expires:
    current_host = host_cpu()
    delta = current_host[0] - previous_host[0]
    host = memory()
    host['cpu_percent'] = 100 * (delta - (current_host[1] - previous_host[1])) / delta if delta else None
    host['iowait_percent'] = 100 * (current_host[2] - previous_host[2]) / delta if delta else None
    host['steal_percent'] = 100 * (current_host[3] - previous_host[3]) / delta if delta else None
    host['memory_used_bytes'] = host['MemTotal'] - host['MemAvailable']
    host['swap_used_bytes'] = host['SwapTotal'] - host['SwapFree']
    try: host['io'] = host_io()
    except (OSError, ValueError, IndexError): host['io'] = None
    previous_host = current_host
    emit({'type': 'host', 'timestamp': time.time(), **host})
    current_containers = [c for c in docker('/containers/json') if c.get('Labels', {}).get('com.docker.compose.project') == project]
    if {c['Id'] for c in current_containers} != {c['Id'] for c in containers}:
        emit({'type': 'container_change', 'timestamp': time.time(), 'services': [c['Labels'].get('com.docker.compose.service') for c in current_containers]})
        containers = current_containers
    for container in containers:
        try:
            stats = docker('/containers/%s/stats?stream=false&one-shot=true' % container['Id'])
            cpu = stats['cpu_stats']
            used = cpu['cpu_usage']['total_usage']
            system = cpu.get('system_cpu_usage', 0)
            previous = previous_containers.get(container['Id'])
            percent = None
            if previous and system > previous[1]:
                percent = 100 * (used - previous[0]) / (system - previous[1]) * cpu.get('online_cpus', os.cpu_count())
            previous_containers[container['Id']] = used, system
            mem = stats.get('memory_stats', {})
            cache = mem.get('stats', {}).get('inactive_file', mem.get('stats', {}).get('total_inactive_file', 0))
            emit({'type': 'container', 'timestamp': time.time(),
                  'name': container['Names'][0].lstrip('/'),
                  'service': container['Labels']['com.docker.compose.service'],
                  'cpu_percent': percent, 'memory_used_bytes': max(0, mem.get('usage', 0) - cache),
                  'memory_usage_bytes': mem.get('usage', 0), 'memory_limit_bytes': mem.get('limit', 0),
                  'networks': stats.get('networks', {}), 'blkio': stats.get('blkio_stats', {})})
        except Exception as error:
            emit({'type': 'error', 'timestamp': time.time(), 'container': container['Id'], 'error': str(error)})
    if time.monotonic() - last_runtime >= 5:
        last_runtime = time.monotonic()
        for container in containers:
            service = container['Labels'].get('com.docker.compose.service')
            try:
                info = docker('/containers/%s/json' % container['Id'])
                state = info.get('State', {})
                emit({'type': 'health', 'timestamp': time.time(), 'service': service,
                      'status': state.get('Status'), 'health': state.get('Health', {}).get('Status'),
                      'oom_killed': state.get('OOMKilled', False), 'restart_count': info.get('RestartCount', 0)})
            except Exception as error:
                emit({'type': 'error', 'timestamp': time.time(), 'container': container['Id'], 'error': str(error)})
            if service not in ('api', 'classifier-worker'): continue
            name = 'api' if service == 'api' else 'worker'
            try:
                result = subprocess.run(['docker', 'exec', container['Id'], 'cat', '/tmp/classifier-runtime-'+name+'.json'], capture_output=True, text=True, timeout=2, check=True)
                sample = json.loads(result.stdout)
                sample['sample_timestamp_ms'] = sample.pop('timestamp', None)
                emit({'type': 'runtime', 'timestamp': time.time(), 'service': service, **sample})
            except (OSError, ValueError, subprocess.SubprocessError): pass
    deadline += 1
    time.sleep(max(0, deadline - time.monotonic()))
