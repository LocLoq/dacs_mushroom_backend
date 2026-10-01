"""Read-only Linux/Docker sampler. Send over SSH stdin; no server files needed."""
import datetime
import http.client
import json
import os
import socket
import subprocess
import sys
import time


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


if '--metadata' in sys.argv:
    def command(*args):
        result = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return {'exit_code': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}
    running = docker('/containers/json')
    services = []
    for entry in running:
        if entry.get('Labels', {}).get('com.docker.compose.project') != 'dacs-mushroom':
            continue
        info = docker('/containers/%s/json' % entry['Id'])
        services.append({'name': info['Name'], 'image': info['Config']['Image'],
                         'image_id': info['Image'], 'state': info['State'],
                         'limits': {key: info['HostConfig'].get(key) for key in
                                    ('Memory', 'MemorySwap', 'NanoCpus', 'CpuQuota', 'CpuPeriod', 'CpusetCpus')}})
    emit({'timestamp': time.time(), 'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'hostname': socket.gethostname(), 'cpu_count': os.cpu_count(), 'memory': memory(),
          'os_release': command('cat', '/etc/os-release'), 'kernel': command('uname', '-a'),
          'lscpu': command('lscpu'), 'disk': command('df', '-B1', '/'),
          'docker_version': docker('/version'), 'compose_version': command('docker', 'compose', 'version'),
          'remote_commit': command('git', '-C', '/home/loql/dacs_mushroom_backend', 'rev-parse', 'HEAD'),
          'remote_git_status': command('git', '-C', '/home/loql/dacs_mushroom_backend', 'status', '--short'),
          'containers': services})
    sys.exit(0)

containers = [c for c in docker('/containers/json')
              if c.get('Labels', {}).get('com.docker.compose.project') == 'dacs-mushroom']
if not containers:
    raise RuntimeError('No running containers in dacs-mushroom project')
emit({'type': 'collector', 'timestamp': time.time(), 'interval_seconds': 1,
      'cpu_count': os.cpu_count(), 'containers': [c['Names'][0].lstrip('/') for c in containers],
      'cpu_definition': 'host: 100*(delta total - delta idle - delta iowait)/delta total; container: Docker CPU delta normalized to one core',
      'memory_definition': 'host: MemTotal - MemAvailable; container working set: memory_stats.usage - inactive_file (Docker CLI convention)'})
previous_host = host_cpu()
previous_containers = {}
deadline = time.monotonic()
expires = deadline + 1800
while time.monotonic() < expires:
    current_host = host_cpu()
    delta = current_host[0] - previous_host[0]
    host = memory()
    host['cpu_percent'] = 100 * (delta - (current_host[1] - previous_host[1])) / delta if delta else None
    host['iowait_percent'] = 100 * (current_host[2] - previous_host[2]) / delta if delta else None
    host['steal_percent'] = 100 * (current_host[3] - previous_host[3]) / delta if delta else None
    host['memory_used_bytes'] = host['MemTotal'] - host['MemAvailable']
    host['swap_used_bytes'] = host['SwapTotal'] - host['SwapFree']
    previous_host = current_host
    emit({'type': 'host', 'timestamp': time.time(), **host})
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
                  'memory_usage_bytes': mem.get('usage', 0), 'memory_limit_bytes': mem.get('limit', 0)})
        except Exception as error:
            emit({'type': 'error', 'timestamp': time.time(), 'container': container['Id'], 'error': str(error)})
    deadline += 1
    time.sleep(max(0, deadline - time.monotonic()))
