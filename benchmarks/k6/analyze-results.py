"""Sanitize k6 summaries, aggregate three repetitions, and plot original measurements."""
import csv
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import sys

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else 'benchmarks/results/2026-10-01-local')
MIB = 1024 ** 2


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(name, value):
    (ROOT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def epoch(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def stats(values):
    values = [v for v in values if v is not None and math.isfinite(v)]
    return {'count': len(values), 'mean': statistics.mean(values),
            'median': statistics.median(values), 'min': min(values), 'max': max(values)} if values else None


metadata = load(ROOT / 'metadata.json')
if not metadata.get('finished_at'):
    raise RuntimeError('Benchmark is incomplete; do not publish final results')
measured = [r for r in metadata['runs'] if r['id'] != 'warmup']
if len(measured) != 12 or any('finished_at' not in r for r in measured):
    raise RuntimeError('Expected twelve completed measured runs')

# Preserve exact script provenance for this session's output-only compatibility fixes.
versions_path = ROOT / 'script-versions.json'
if versions_path.exists():
    versions = load(versions_path)
    metadata['generator'].setdefault('initial_script_sha256', metadata['generator']['script_sha256'])
    metadata['generator']['script_sha256'] = versions['final_script_sha256']
    for run in metadata['runs']:
        run['script_sha256'] = (versions['warmup_sha256'] if run['id'] == 'warmup' else
                                versions['measured_script_sha256'] if run['id'] == 'vu10-r1' else
                                versions['final_script_sha256'])
    write_json('metadata.json', metadata)

# Legacy k6 embeds setup return data. Remove tokens before any artifact is published.
for summary_path in ROOT.glob('*.summary.json'):
    summary = load(summary_path)
    summary.pop('setup_data', None)
    summary_path.write_text(json.dumps(summary, indent=2), encoding='utf-8')
for log_path in ROOT.glob('*.log'):
    text = log_path.read_text(encoding='utf-8')
    text = re.sub(r'"token"\s*:\s*"[^"]*"', '"token": "[REDACTED]"', text)
    log_path.write_text(text, encoding='utf-8')

resources = [json.loads(line) for line in (ROOT / 'resources.ndjson').read_text(encoding='utf-8').splitlines() if line]
errors = [r for r in resources if r['type'] == 'error']
if errors:
    raise RuntimeError('Resource collection errors: %s' % len(errors))
offset = metadata['clock_offset_ms'] / 1000
host_samples = [r for r in resources if r['type'] == 'host']
intervals = [b['timestamp'] - a['timestamp'] for a, b in zip(host_samples, host_samples[1:])]


def resource_stats(start, end):
    selected = [r for r in resources if start <= r.get('timestamp', 0) <= end]
    output = {}
    for name in ('host', 'api', 'db', 'redis', 'classifier'):
        samples = [r for r in selected if r['type'] == 'host'] if name == 'host' else [
            r for r in selected if r['type'] == 'container' and r['service'] == name]
        if len(samples) < 10:
            raise RuntimeError('Too few resource samples for %s' % name)
        output[name] = {'samples': len(samples), 'cpu_percent': stats([r['cpu_percent'] for r in samples]),
                        'memory_mib': stats([r['memory_used_bytes'] / MIB for r in samples])}
        if name == 'host':
            output[name]['swap_mib'] = stats([r['swap_used_bytes'] / MIB for r in samples])
            output[name]['iowait_percent'] = stats([r['iowait_percent'] for r in samples])
            output[name]['steal_percent'] = stats([r['steal_percent'] for r in samples])
    return output


rows = []
per_run_resources = {}
all_thresholds_passed = True
for run in measured:
    summary = load(ROOT / (run['id'] + '.summary.json'))
    metrics = summary['metrics']
    latency = metrics['http_req_duration{phase:business}']['values']
    count = metrics['business_requests']['values']['count']
    checks = metrics['checks{phase:business}']['values']
    log = (ROOT / (run['id'] + '.log')).read_text(encoding='utf-8')
    dataset = int(re.search(r'Dataset: (\d+) batches', log).group(1))
    ok = all(t['ok'] for m in metrics.values() for t in m.get('thresholds', {}).values())
    all_thresholds_passed &= ok
    if run['exit_code'] != (0 if ok else 99):
        raise RuntimeError('Threshold status and exit code differ')
    if checks['passes'] + checks['fails'] != 2 * count:
        raise RuntimeError('Missing business checks')
    start = epoch(run['started_at']) + offset
    end = epoch(run['finished_at']) + offset
    resource = resource_stats(start, end)
    per_run_resources[run['id']] = resource
    rows.append({'run': run['id'], 'vus': run['vus'], 'batches': dataset,
                 'duration_s': run['duration_seconds'], 'business_requests': count,
                 'k6_elapsed_s': summary['state']['testRunDurationMs'] / 1000,
                 'avg_ms': latency['avg'], 'p50_ms': latency['med'], 'p95_ms': latency['p(95)'],
                 'p99_ms': latency['p(99)'], 'max_ms': latency['max'],
                 'requests_per_s': metrics['business_requests']['values']['rate'],
                 'http_errors_pct': metrics['http_req_failed{phase:business}']['values']['rate'] * 100,
                 'checks_passed_pct': checks['rate'] * 100, 'thresholds_passed': ok,
                 'host_cpu_mean_pct': resource['host']['cpu_percent']['mean'],
                 'host_cpu_max_pct': resource['host']['cpu_percent']['max'],
                 'host_ram_mean_mib': resource['host']['memory_mib']['mean'],
                 'host_ram_max_mib': resource['host']['memory_mib']['max'],
                 'api_cpu_mean_pct': resource['api']['cpu_percent']['mean'],
                 'api_ram_mean_mib': resource['api']['memory_mib']['mean']})

if {r['batches'] for r in rows} != {100}:
    raise RuntimeError('Unexpected dataset size')
with (ROOT / 'runs.csv').open('w', encoding='utf-8', newline='') as output:
    writer = csv.DictWriter(output, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)

groups = []
for vus in metadata['protocol']['vus']:
    subset = [r for r in rows if r['vus'] == vus]
    group = {'vus': vus, 'repeats': len(subset), 'requests_total': sum(r['business_requests'] for r in subset)}
    for key in ('p50_ms', 'p95_ms', 'p99_ms', 'requests_per_s', 'http_errors_pct', 'checks_passed_pct'):
        group[key] = stats([r[key] for r in subset])
    group['resources'] = {}
    for service in ('host', 'api', 'db', 'redis', 'classifier'):
        matched = [r for r in resources if any(
            epoch(run['started_at']) + offset <= r.get('timestamp', 0) <= epoch(run['finished_at']) + offset
            for run in measured if run['vus'] == vus)]
        samples = [r for r in matched if r['type'] == 'host'] if service == 'host' else [
            r for r in matched if r['type'] == 'container' and r['service'] == service]
        group['resources'][service] = {'samples': len(samples),
            'cpu_percent': stats([r['cpu_percent'] for r in samples]),
            'memory_mib': stats([r['memory_used_bytes'] / MIB for r in samples])}
    groups.append(group)

baseline = resource_stats(epoch(metadata['baseline_started_at']) + offset,
                          epoch(metadata['baseline_finished_at']) + offset)
analysis = {'groups': groups, 'runs': rows, 'resources_by_run': per_run_resources,
            'baseline': baseline, 'sample_interval_s': stats(intervals),
            'all_thresholds_passed': all_thresholds_passed,
            'total_business_requests': sum(r['business_requests'] for r in rows),
            'resource_errors': len(errors), 'resource_window': 'SSH-corrected wrapper start/end; includes login, data probe and graceful drain',
            'aggregation': 'HTTP table: median and min/max across 3 run statistics (not a pooled percentile); CPU/RAM: arithmetic mean and peak of 1s samples pooled across measured windows'}
write_json('analysis.json', analysis)
write_json('source-sha256.json', {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in sorted(Path(__file__).parent.iterdir()) if p.is_file()})

lines = ['# Benchmark 2026-10-01', '', '12 measured runs; 100 batches; 60 seconds per run; 1 second think time.', '',
         '| VU | p95 median [min, max] ms | p99 median [min, max] ms | RPS median [min, max] | Error % | Checks % |',
         '| ---: | ---: | ---: | ---: | ---: | ---: |']
def range_text(value):
    return '%.2f [%.2f, %.2f]' % (value['median'], value['min'], value['max'])
for group in groups:
    lines.append('| %s | %s | %s | %s | %.2f | %.2f |' % (
        group['vus'], range_text(group['p95_ms']), range_text(group['p99_ms']),
        range_text(group['requests_per_s']), group['http_errors_pct']['max'], group['checks_passed_pct']['min']))
lines += ['', '## Server resources', '', '| VU | Service | CPU mean / peak % | RAM mean / peak MiB | Samples |',
          '| ---: | --- | ---: | ---: | ---: |']
for group in groups:
    for service, value in group['resources'].items():
        lines.append('| %s | %s | %.2f / %.2f | %.2f / %.2f | %s |' % (
            group['vus'], service, value['cpu_percent']['mean'], value['cpu_percent']['max'],
            value['memory_mib']['mean'], value['memory_mib']['max'], value['samples']))
(ROOT / 'summary.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams.update({'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False})
fig, axes = plt.subplots(1, 2, figsize=(11, 4), layout='constrained')
x = [g['vus'] for g in groups]
for name, label, color in [('p95_ms', 'p95', '#1565c0'), ('p99_ms', 'p99', '#d55e00')]:
    med = [g[name]['median'] for g in groups]
    axes[0].errorbar(x, med, yerr=[[g[name]['median'] - g[name]['min'] for g in groups],
                                  [g[name]['max'] - g[name]['median'] for g in groups]],
                     marker='o', capsize=4, color=color, label=label)
axes[0].set(xlabel='Virtual users (VU)', ylabel='HTTP latency (ms)', title='Median of 3 runs; bars = min/max')
axes[0].legend()
med = [g['requests_per_s']['median'] for g in groups]
axes[1].errorbar(x, med, yerr=[[g['requests_per_s']['median'] - g['requests_per_s']['min'] for g in groups],
                              [g['requests_per_s']['max'] - g['requests_per_s']['median'] for g in groups]],
                 marker='o', capsize=4, color='#00796b')
axes[1].set(xlabel='Virtual users (VU)', ylabel='Business requests / second', title='GET list batches; sleep(1); 60s/run')
for axis in axes:
    axis.set_xticks(x)
    axis.grid(alpha=0.25)
fig.savefig(ROOT / 'performance.png', dpi=180)
plt.close(fig)

fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True, layout='constrained')
origin = epoch(metadata['baseline_started_at']) + offset
for service, color in [('host', '#222222'), ('api', '#1565c0'), ('db', '#d55e00'),
                       ('redis', '#00796b'), ('classifier', '#7b1fa2')]:
    samples = [r for r in resources if r['type'] == 'host'] if service == 'host' else [
        r for r in resources if r['type'] == 'container' and r['service'] == service]
    xs = [(r['timestamp'] - origin) / 60 for r in samples]
    axes[0].plot(xs, [r['cpu_percent'] for r in samples], label=service, color=color, linewidth=0.8, alpha=0.85)
    axes[1].plot(xs, [r['memory_used_bytes'] / MIB for r in samples], label=service, color=color, linewidth=1)
for vus, color in [(10, '#d9eaf7'), (25, '#e2efda'), (50, '#fff2cc'), (100, '#fce4d6')]:
    runs = [r for r in measured if r['vus'] == vus]
    start = (epoch(runs[0]['started_at']) + offset - origin) / 60
    end = (epoch(runs[-1]['finished_at']) + offset - origin) / 60
    for axis in axes:
        axis.axvspan(start, end, color=color, alpha=0.4, zorder=-1)
    axes[0].text((start + end) / 2, 1.01, '%s VU' % vus, transform=axes[0].get_xaxis_transform(), ha='center')
axes[0].set(ylabel='CPU (%)')
axes[0].set_title('SSH server samples (~1s); shaded windows include 5s gaps between repetitions', pad=28)
axes[0].legend(ncol=5, loc='upper left')
axes[1].set(xlabel='Minutes since baseline start', ylabel='Memory (MiB)')
for axis in axes:
    axis.grid(alpha=0.25)
fig.savefig(ROOT / 'resources.png', dpi=180)
plt.close(fig)

manifest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ROOT.iterdir())
            if p.is_file() and p.name != 'sha256.json'}
write_json('sha256.json', manifest)
print('\n'.join(lines))
