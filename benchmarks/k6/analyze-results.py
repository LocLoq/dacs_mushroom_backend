"""Summarize mixed-workload k6 and SSH resource artifacts without exposing tokens."""
import csv
import datetime as dt
import json
import math
from pathlib import Path
import re
import statistics
import sys
import hashlib

if len(sys.argv) != 2:
    raise SystemExit('Usage: python analyze-results.py RESULTS_DIR')
root = Path(sys.argv[1])
metadata = json.loads((root / 'metadata.json').read_text(encoding='utf-8'))
if metadata.get('profile') not in ('smoke', 'full', 'calibration-100-vu', 'steps-2000', 'steps-1000'):
    raise SystemExit('This analyzer expects a mixed-workload benchmark')

def load_summary(phase):
    file = root / (phase + '.summary.json')
    if not file.exists():
        return {}
    try:
        data = json.loads(file.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        return {}
    data.pop('setup_data', None)
    return data.get('metrics', {})

def epoch(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()

def values(metric):
    return metric.get('values', {})

def finite(values):
    return [v for v in values if isinstance(v, (int, float)) and math.isfinite(v)]

def describe(items):
    items = finite(items)
    return {'samples': len(items), 'mean': statistics.mean(items), 'max': max(items)} if items else None

def method(endpoint):
    if endpoint in {'facility_update', 'batch_update', 'species_update', 'admin_user_update'}:
        return 'PUT'
    if endpoint in {'task_update', 'expense_update', 'sale_update', 'gallery_update', 'notification_read'}:
        return 'PATCH'
    if endpoint.endswith('_delete') or endpoint.endswith('_revoke'):
        return 'DELETE'
    if endpoint.endswith('_create') or endpoint.endswith('_grant') or endpoint in {'classifier_submit', 'task_submit', 'task_review', 'gallery_upload'}:
        return 'POST'
    return 'GET'

metrics = load_summary('measured')
preflight = load_summary('preflight')
rows = []
pattern = re.compile(r'^business_requests\{endpoint:([^,]+),role:([^}]+)\}$')
for key, metric in metrics.items():
    match = pattern.match(key)
    if not match:
        continue
    endpoint, role = match.groups()
    count = values(metric).get('count', 0)
    if not count:
        continue
    latency = values(metrics.get(f'http_req_duration{{endpoint:{endpoint},role:{role}}}', {}))
    rows.append({'role': role, 'method': method(endpoint), 'endpoint': endpoint, 'requests': count,
                 'avg_ms': latency.get('avg'), 'p50_ms': latency.get('med'),
                 'p95_ms': latency.get('p(95)'), 'p99_ms': latency.get('p(99)')})
rows.sort(key=lambda row: (row['role'], row['endpoint']))
with (root / 'endpoints.csv').open('w', encoding='utf-8', newline='') as output:
    writer = csv.DictWriter(output, fieldnames=['role', 'method', 'endpoint', 'requests', 'avg_ms', 'p50_ms', 'p95_ms', 'p99_ms'])
    writer.writeheader()
    writer.writerows(rows)

coverage = []
for key, metric in preflight.items():
    match = pattern.match(key)
    if match and values(metric).get('count', 0):
        coverage.append({'endpoint': match.group(1), 'method': method(match.group(1)), 'role': match.group(2), 'requests': values(metric)['count']})
coverage.sort(key=lambda row: (row['role'], row['endpoint']))
with (root / 'coverage.csv').open('w', encoding='utf-8', newline='') as output:
    writer = csv.DictWriter(output, fieldnames=['role', 'method', 'endpoint', 'requests'])
    writer.writeheader()
    writer.writerows(coverage)

failures = {}
for reason in ('rate_limit', 'auth', 'server', 'network', 'response'):
    failures[reason] = values(metrics.get(f'business_failures{{reason:{reason}}}', {})).get('count', 0)
action_counts = {}
job_outcomes = {}
for role in ('admin', 'manager', 'staff', 'guest'):
    action_counts[role] = {action: values(metrics.get(f'business_actions{{action:{action},role:{role}}}', {})).get('count', 0)
                           for action in ('read', 'write', 'classify')}
    job_outcomes[role] = {outcome: values(metrics.get(f'classifier_jobs{{outcome:{outcome},role:{role}}}', {})).get('count', 0)
                          for outcome in ('succeeded', 'failed', 'timeout', 'rejected', 'invalid')}
if not metrics:
    failures = None
    action_counts = None
    job_outcomes = None
classifier_totals = None
if job_outcomes is not None:
    classifier_totals = {key: sum(row[key] for row in job_outcomes.values()) for key in ('succeeded', 'failed', 'timeout', 'rejected', 'invalid')}
    classifier_totals['attempted'] = sum(classifier_totals.values())
    classifier_totals['accepted'] = classifier_totals['attempted'] - classifier_totals['rejected'] - classifier_totals['invalid']
    classifier_totals['success_all_percent'] = 100 * classifier_totals['succeeded'] / classifier_totals['attempted'] if classifier_totals['attempted'] else None
    classifier_totals['success_accepted_percent'] = 100 * classifier_totals['succeeded'] / classifier_totals['accepted'] if classifier_totals['accepted'] else None
resource_summary = {}
resource_file = root / 'resources.ndjson'
resources = []
run = next((row for row in metadata.get('runs', []) if row['id'] == 'measured'), None)
if resource_file.exists() and run and run.get('finished_at'):
    for line in resource_file.read_text(encoding='utf-8').splitlines():
        try:
            record = json.loads(line)
            if record.get('type') == 'runtime' and record.get('timestamp', 0) > 100000000000:
                record['sample_timestamp_ms'] = record['timestamp']
                record['timestamp'] /= 1000
            resources.append(record)
        except ValueError: continue
    offset = metadata.get('clock_offset_ms', 0) / 1000
    start, end = epoch(run['started_at']) + offset, epoch(run['finished_at']) + offset
    for service in ('host', 'api', 'db', 'redis', 'redis-cache', 'classifier', 'classifier-worker'):
        selected = [row for row in resources if start <= row.get('timestamp', 0) <= end and
                    (row.get('type') == 'host' if service == 'host' else row.get('type') == 'container' and row.get('service') == service)]
        resource_summary[service] = {'cpu_percent': describe([row.get('cpu_percent') for row in selected]),
                                     'memory_mib': describe([row.get('memory_used_bytes', 0) / 1048576 for row in selected])}
    resource_summary['collection_errors'] = sum(row.get('type') == 'error' for row in resources)
    runtime_cache = [row.get('cache') for row in resources if row.get('type') == 'runtime' and row.get('service') == 'api' and start <= row.get('timestamp', 0) <= end and isinstance(row.get('cache'), dict)]
    redis_cache = [row for row in resources if row.get('type') == 'cache_runtime' and start <= row.get('timestamp', 0) <= end]
    if runtime_cache:
        resource_summary['cache_counters'] = {key: runtime_cache[-1].get(key, 0) - runtime_cache[0].get(key, 0) for key in ('hit', 'miss', 'bypass', 'error', 'invalidation', 'coalesced')}
    if redis_cache:
        resource_summary['cache_redis'] = {'peak_used_memory_bytes': max(row.get('used_memory', 0) for row in redis_cache),
                                           'evicted_keys': redis_cache[-1].get('evicted_keys', 0) - redis_cache[0].get('evicted_keys', 0)}

def metric_values(name):
    return values(metrics.get(name, {}))

thresholds = {name: metric.get('thresholds') for name, metric in metrics.items() if metric.get('thresholds')}
analysis = {'profile': metadata['profile'], 'mode': metadata['mode'], 'roles': metadata['roles'],
            'requests': metric_values('business_requests'), 'http_failed': metric_values('http_req_failed{phase:business}'),
            'checks': metric_values('checks{phase:business}'), 'read_latency_ms': metric_values('http_req_duration{phase:business,kind:read}'),
            'failure_reasons': failures, 'action_counts': action_counts, 'classifier_outcomes': job_outcomes, 'classifier_jobs': metric_values('classifier_jobs'),
            'classifier_success': metric_values('classifier_success'), 'classifier_queue_ms': metric_values('classifier_queue_ms'),
            'classifier_totals': classifier_totals, 'classifier_admission_rejected': metric_values('classifier_admission_rejected'),
            'classifier_model_ms': metric_values('classifier_model_ms'), 'classifier_preprocess_ms': metric_values('classifier_preprocess_ms'),
            'classifier_processing_ms': metric_values('classifier_processing_ms'), 'classifier_total_ms': metric_values('classifier_total_ms'),
            'socket_events': metric_values('socket_events'), 'resources': resource_summary,
            'thresholds': thresholds, 'preflight_coverage': coverage, 'endpoints': rows,
            'measurement_window': 'measured wrapper start to exit; includes graceful job drain'}

missing = []
def require(condition, description):
    if not condition: missing.append(description)

require(metadata.get('schema_version') == 2, 'Metadata phiên bản 2 và nguồn thu thập')
require(not metadata.get('incomplete') and metadata.get('finished_at'), 'Lượt đo hoàn tất')
for phase in ('preflight', 'warmup', 'measured'):
    record = next((row for row in metadata.get('runs', []) if row.get('id') == phase), {})
    require(record.get('exit_code') in ((0, 99) if phase == 'measured' else (0,)), 'Giai đoạn ' + phase + ' hoàn thành')
    require(bool(load_summary(phase)), 'Summary ' + phase + ' hợp lệ')
required_coverage = [metric for key, metric in preflight.items() if pattern.match(key) and 'count>0' in metric.get('thresholds', {})]
require(bool(required_coverage) and all(metric.get('thresholds', {}).get('count>0', {}).get('ok') and values(metric).get('count', 0) > 0 for metric in required_coverage), 'Danh mục endpoint preflight bắt buộc')
require(metadata.get('sampler') == 'ssh' and bool(metadata.get('server')), 'Snapshot và sampler server qua SSH')
require(bool(metadata.get('server_after')), 'Snapshot server sau lượt đo')
require(bool(metadata.get('effective_api')), 'Chế độ API hiệu lực được xác minh')
for name in ('prometheus', 'grafana'):
    require(metadata.get('monitoring', {}).get(name, {}).get('status') == 'ok', 'Phiên bản và trạng thái ' + name)
require(bool(metadata.get('generator', {}).get('system')), 'Thông tin hệ thống máy sinh tải')
require(bool(metadata.get('source_ip_count_declared')), 'Số IP nguồn')
require(bool(metadata.get('generator', {}).get('k6')) and bool(metadata.get('generator', {}).get('script_sha256')), 'Phiên bản k6 và hash kịch bản')
require(bool(metadata.get('generator', {}).get('seed_sha256')) and bool(metadata.get('generator', {}).get('image_sha256')), 'Hash seed và ảnh nhận diện')
require(bool(metadata.get('server', {}).get('cpu_count')) and bool(metadata.get('server', {}).get('memory', {}).get('MemTotal')), 'CPU/RAM server')
require(metadata.get('server', {}).get('os_release', {}).get('exit_code') == 0 and metadata.get('server', {}).get('disk', {}).get('exit_code') == 0, 'Hệ điều hành và ổ đĩa server')
required_versions = {'api': ('runtime', 'npm', 'node_dependencies', 'source_hash', 'database_runtime', 'os_packages'),
                     'db': ('server', 'os_packages'), 'redis': ('server', 'os_packages'),
                     'classifier': ('python', 'python_dependencies', 'model_hashes', 'model_runtime', 'os_packages')}
if metadata.get('roles', {}).get('guest') in (895, 1795):
    required_versions['redis-cache'] = ('server', 'memory', 'stats', 'os_packages')
containers_by_service = {item.get('service'): item for item in metadata.get('server', {}).get('containers', [])}
for service, names in required_versions.items():
    item = containers_by_service.get(service, {})
    require(bool(item.get('image_id')), 'Image thực chạy của ' + service)
    for name in names:
        result = item.get('versions', {}).get(name, {})
        require(result.get('exit_code') == 0 and bool(result.get('stdout')), 'Phiên bản ' + service + '/' + name)
for item in metadata.get('server', {}).get('containers', []):
    if item.get('service') in ('api', 'db', 'redis', 'classifier'):
        for name, result in item.get('versions', {}).items():
            require(result.get('exit_code') == 0 and bool(result.get('stdout')), 'Phiên bản ' + item['service'] + '/' + name)

def time_coverage(times, start, end, interval):
    times = sorted(set(value for value in times if start <= value <= end))
    if not times or end <= start: return {'fraction': 0, 'max_gap_seconds': None}
    boundaries = [start] + times + [end]
    gaps = [b - a for a, b in zip(boundaries, boundaries[1:])]
    covered = sum(min(interval, gap) for gap in gaps)
    return {'fraction': min(1, covered / (end - start)), 'max_gap_seconds': max(gaps)}

sampling = {}
peak_vus, hold_seconds_10000, hold_seconds_2000, hold_seconds_1000 = None, None, None, None
genrows = []
if run and run.get('finished_at'):
    start, end = epoch(run['started_at']), epoch(run['finished_at'])
    offset = metadata.get('clock_offset_ms', 0) / 1000
    sampling['server'] = time_coverage([r['timestamp'] - offset for r in resources if r.get('type') == 'host' and 'timestamp' in r], start, end, 1)
    genfile = root / 'generator-resources.ndjson'
    if genfile.exists():
        for line in genfile.read_text(encoding='utf-8').splitlines():
            try: genrows.append(json.loads(line))
            except ValueError: continue
    sampling['generator'] = time_coverage([r['timestamp'] for r in genrows if 'timestamp' in r and 'cpu_percent' in r], start, end, 1)
    sampling['generator_io'] = time_coverage([r['timestamp'] for r in genrows if r.get('type') == 'io' and 'timestamp' in r], start, end, 5)
    seriesfile = root / 'timeseries.json'
    series = json.loads(seriesfile.read_text(encoding='utf-8')) if seriesfile.exists() else {}
    if metadata.get('roles', {}).get('guest') in (895, 1795):
        require('input_coverage' in series and 'error' not in series['input_coverage'], 'Độ phủ dữ liệu đầu vào từ Prometheus')
        observed = series.get('input_coverage', {}).get('result', [])
        analysis['input_coverage'] = {dimension: len({item.get('metric', {}).get('slot') for item in observed if item.get('metric', {}).get('dimension') == dimension and item.get('values')}) for dimension in ('species', 'batch', 'search', 'page')}
    for name in ('vus', 'rps', 'latency_p95', 'failures', 'classifier'):
        require(name in series and 'error' not in series[name], 'Truy vấn Prometheus ' + name)
    vus = series.get('vus', {}).get('result', [])
    vu_points = [(float(pair[0]), float(pair[1])) for item in vus for pair in item.get('values', [])]
    if vu_points:
        peak_vus = max(value for _, value in vu_points)
        if metadata.get('profile') == 'full' and metadata.get('roles', {}).get('guest') not in (895, 1795):
            hold_seconds_10000 = 5 * sum(start + 480 <= stamp < start + 2280 and value >= 10000 for stamp, value in vu_points)
        elif metadata.get('profile') == 'full' and metadata.get('roles', {}).get('guest') == 1795:
            hold_seconds_2000 = 5 * sum(start + 240 <= stamp < start + 540 and value >= 2000 for stamp, value in vu_points)
        elif metadata.get('profile') == 'full':
            hold_seconds_1000 = 5 * sum(start + 240 <= stamp < start + 540 and value >= 1000 for stamp, value in vu_points)
    sampling['prometheus_vus'] = time_coverage([float(pair[0]) for item in vus for pair in item.get('values', [])], start, end, 5)
    for name, check in sampling.items():
        require(check['fraction'] >= .95 and check['max_gap_seconds'] is not None and check['max_gap_seconds'] <= 15,
                'Độ bao phủ dữ liệu thời gian ' + name + ' (>=95%, khoảng trống <=15 giây)')
else:
    require(False, 'Cửa sổ đo và dữ liệu thời gian')
if any(row.get('type') in ('error', 'container_change') for row in resources):
    require(False, 'Sampler không lỗi và container không thay đổi')
before = metadata.get('server', {}).get('containers', [])
after = metadata.get('server_after', {}).get('containers', [])
if before and after:
    identity = lambda items: sorted((item.get('service'), item.get('image_id'), item.get('state', {}).get('restart_count'), json.dumps(item.get('config', {}), sort_keys=True)) for item in items)
    require(identity(before) == identity(after), 'Cấu hình/image/restart nhất quán trước và sau đo')

core_threshold_names = ('http_req_duration{phase:business,kind:read}', 'http_req_failed{phase:business}', 'checks{phase:business}')
core_thresholds = {name: thresholds.get(name) for name in core_threshold_names}
performance = None if any(not item for item in core_thresholds.values()) else all(entry.get('ok') for item in core_thresholds.values() for entry in item.values())
threshold_log = (root / 'measured.log').read_text(encoding='utf-8', errors='replace') if (root / 'measured.log').exists() else ''
threshold_match = re.search(r"thresholds on metrics '([^']+)' have been crossed", threshold_log)
crossed_thresholds = [name for name in core_threshold_names if threshold_match and name in threshold_match.group(1)]
if crossed_thresholds:
    performance = False
if metadata.get('roles', {}).get('guest') in (895, 1795) and metrics:
    isolation = metric_values('isolation_checks')
    require(isolation.get('passes', 0) > 0 and isolation.get('rate') == 1, 'Kiểm tra cách ly cơ sở đạt 100%')
    require(bool(metadata.get('cache_preparation')), 'Trạng thái cache trước tải được xác minh')
    require(metric_values('cache_responses{outcome:error}').get('count', 0) == 0, 'Cache không lỗi trong lượt đo')
    require('cache_counters' in resource_summary and 'cache_redis' in resource_summary, 'Số liệu cache middleware và Redis cache')
stage_latency = {stage: metric_values('http_req_duration{kind:read,phase:business,stage:' + stage + '}')
                 for stage in ('ramp_1', 'ramp_2', 'ramp_3', 'ramp_4', 'hold', 'ramp_down', 'drain')}
stage_metrics = []
for stage, latency in stage_latency.items():
    requests = metric_values('business_requests{stage:' + stage + '}').get('count', 0)
    errors = metric_values('http_req_failed{phase:business,stage:' + stage + '}')
    checks = metric_values('checks{phase:business,stage:' + stage + '}')
    stage_metrics.append({'stage': stage, 'requests': requests, 'http_error_rate': errors.get('rate'),
                          'checks_rate': checks.get('rate'), 'read_p95_ms': latency.get('p(95)'), 'read_p99_ms': latency.get('p(99)')})
with (root / 'stages.csv').open('w', encoding='utf-8', newline='') as output:
    writer = csv.DictWriter(output, fieldnames=['stage', 'requests', 'http_error_rate', 'checks_rate', 'read_p95_ms', 'read_p99_ms'])
    writer.writeheader(); writer.writerows(stage_metrics)
total_actions = sum(sum(row.values()) for row in (action_counts or {}).values())
classifier_actions = sum(row['classify'] for row in (action_counts or {}).values())
analysis.update({'performance_passed': performance, 'stage_read_latency_ms': stage_latency, 'sampling': sampling,
                 'stage_metrics': stage_metrics,
                 'thresholds_crossed_in_k6_log': crossed_thresholds,
                 'peak_vus': peak_vus, 'hold_seconds_at_10000_vus': hold_seconds_10000,
                 'hold_seconds_at_2000_vus': hold_seconds_2000,
                 'hold_seconds_at_1000_vus': hold_seconds_1000,
                 'isolation_checks': metric_values('isolation_checks'),
                 'isolation_outcomes': {outcome: metric_values('isolation_outcomes{outcome:' + outcome + '}').get('count', 0) for outcome in ('passed', 'violation', 'inconclusive', 'mismatch')} if any(key.startswith('isolation_outcomes{') for key in metrics) else None,
                 'cache_responses': {outcome: metric_values('cache_responses{outcome:' + outcome + '}') for outcome in ('hit', 'miss', 'bypass', 'error')},
                 'facility_requests': {str(slot): metric_values('business_requests{facility_slot:' + str(slot) + '}') for slot in range(10)},
                 'classifier_action_fraction': classifier_actions / total_actions if total_actions else None})
readiness = {'schema_version': 2, 'ready': not missing, 'missing': missing, 'sampling': sampling,
             'performance_passed': performance, 'profile': metadata.get('profile'), 'incomplete': bool(metadata.get('incomplete'))}
versions = {'schema_version': 2, 'generator': metadata.get('generator', {}), 'monitoring': metadata.get('monitoring'),
            'server_containers': [{k: c.get(k) for k in ('service', 'image', 'image_id', 'repo_digests', 'versions')} for c in before]}
environment = {'schema_version': 2, 'server_before': metadata.get('server'), 'server_after': metadata.get('server_after'),
               'generator': metadata.get('generator', {}).get('system'), 'effective_api': metadata.get('effective_api'),
               'mode': metadata.get('mode'), 'rate_limits_declared': metadata.get('rate_limits_declared'), 'rate_limits_effective': metadata.get('rate_limits_effective'),
               'roles': metadata.get('roles'), 'profile': metadata.get('profile'), 'runs': metadata.get('runs'),
               'methodology': {'think_time_seconds': [2, 5], 'classifier_action_probability': .05,
                               'classifier_deadline_ms': 900000, 'load_profile_minutes': [1, 1, 1, 1, 5, 1] if metadata.get('roles', {}).get('guest') in (895, 1795) else [2, 2, 2, 2, 30, 2],
                               'cache_case': metadata.get('cache_case'), 'distribution': metadata.get('distribution'), 'cache_preparation': metadata.get('cache_preparation')}}
for name, value in [('versions.json', versions), ('environment.json', environment), ('readiness.json', readiness)]:
    (root / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
(root / 'readiness.md').write_text('# Kiểm tra dữ liệu báo cáo\n\n' + ('Đủ dữ liệu.\n' if not missing else 'Chưa đủ dữ liệu:\n\n' + ''.join('- ' + item + '\n' for item in missing)) +
    '\nTrạng thái hiệu năng: ' + ('đạt' if performance is True else 'không đạt' if performance is False else 'chưa xác định') + '.\n', encoding='utf-8')
(root / 'analysis.json').write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding='utf-8')

system = metadata.get('generator', {}).get('system', {})
lines = ['# Báo cáo benchmark', '', f"- Đủ dữ liệu viết báo cáo: {'Có' if readiness['ready'] else 'Chưa'}; hiệu năng: {'đạt' if performance is True else 'không đạt' if performance is False else 'chưa xác định'}",
         f"- Lần chạy: {metadata['run_id']} / {metadata['profile']} / {metadata['mode']}",
         f"- Đích: {metadata.get('base_url', 'chưa biết')}; vai trò: {metadata.get('roles', {})}",
         f"- IP nguồn: {metadata.get('source_ips', 'chưa biết')}; số IP khai báo: {metadata.get('source_ip_count_declared', 'chưa biết')}", f"- Rate limit khai báo: {metadata.get('rate_limits_declared', 'chưa biết')}; hiệu lực: {metadata.get('rate_limits_effective', 'chưa xác minh')}",
         f"- Request: {analysis['requests'].get('count', 'chưa có summary')}; tỷ lệ lỗi HTTP: {analysis['http_failed'].get('rate', 'chưa có')}",
         f"- Phân loại lỗi: {failures if failures is not None else 'chưa có summary'}; kiểm tra: {analysis['checks'] or 'chưa có summary'}", f"- Job nhận diện: {analysis['classifier_jobs'] or 'chưa có summary'}; thành công: {analysis['classifier_success'] or 'chưa có summary'}",
         f"- Nhận diện theo lượt gửi và job được chấp nhận: {classifier_totals if classifier_totals is not None else 'chưa có summary'}; từ chối do hàng đợi đầy: {analysis['classifier_admission_rejected'] or 'không ghi nhận'}",
         f"- Thời gian tiền xử lý/model (ms, job có kết quả): {analysis['classifier_preprocess_ms'] or 'không có mẫu'} / {analysis['classifier_model_ms'] or 'không có mẫu'}",
         f"- Thao tác theo vai trò: {action_counts if action_counts is not None else 'chưa có summary'}", f"- Job theo vai trò: {job_outcomes if job_outcomes is not None else 'chưa có summary'}",
         f"- Số cặp vai trò/endpoint trong preflight: {len(coverage)}", '',
         f"- VU quan sát tối đa: {peak_vus}; số giây giữ 1.000 VU: {hold_seconds_1000}; số giây giữ 2.000 VU: {hold_seconds_2000}; số giây giữ 10.000 VU (dữ liệu cũ): {hold_seconds_10000}; tỷ lệ thao tác nhận diện: {analysis['classifier_action_fraction']}.",
         f"- Cache: {metadata.get('cache_case')}; phân bố: {metadata.get('distribution')}; thống kê: {analysis['cache_responses']}; kiểm tra cách ly: {analysis['isolation_checks']}.",
         f"- Phân loại probe cách ly: {analysis['isolation_outcomes'] if analysis['isolation_outcomes'] is not None else 'Không có dữ liệu phân loại trong kết quả cũ'}.",
         f"- Request theo cơ sở (slot): {analysis['facility_requests']}.",
         '## Phiên bản và hệ thống', '',
         f"- Máy sinh tải: {system.get('platform', 'chưa thu thập')} {system.get('release', '')}, {system.get('architecture', '')}; CPU {system.get('cpu_model', 'chưa thu thập')} ({system.get('cpu_count', '?')} luồng), RAM {system.get('total_memory_bytes', '?')} byte.",
         f"- k6: {metadata.get('generator', {}).get('k6', 'chưa thu thập')}; Node: {metadata.get('generator', {}).get('node', 'chưa thu thập')}.",
         f"- Server: {metadata.get('server', {}).get('hostname', 'chưa thu thập')}; CPU {metadata.get('server', {}).get('cpu_count', '?')} luồng; RAM {metadata.get('server', {}).get('memory', {}).get('MemTotal', '?')} byte.",
         f"- Monitoring: {metadata.get('monitoring', {})}",
         f"- Thời gian từng giai đoạn: {metadata.get('runs', [])}",
         f"- Độ trễ tiếp nhận ảnh khách: {metric_values('http_req_duration{endpoint:classifier_submit,role:guest}')}; chờ hàng đợi: {analysis['classifier_queue_ms']}; xử lý: {analysis['classifier_processing_ms']}; đầu cuối: {analysis['classifier_total_ms']}.",
         f"- Tài nguyên trong cửa sổ đo: {resource_summary}", '',
         '- Mẫu CPU/RAM và network/disk của máy sinh tải: generator-resources.ndjson; mẫu server/container: resources.ndjson.', '',
         '## Endpoint theo vai trò', '',
         '| Vai trò | Endpoint | Request | p50 ms | p95 ms | p99 ms |', '| --- | --- | ---: | ---: | ---: | ---: |']
for row in rows:
    fmt = lambda value: '–' if value is None else f'{value:.2f}'
    lines.append(f"| {row['role']} | {row['endpoint']} | {row['requests']} | {fmt(row['p50_ms'])} | {fmt(row['p95_ms'])} | {fmt(row['p99_ms'])} |")
if metadata.get('profile') == 'calibration-100-vu':
    lines.extend(['', 'Đây là lượt hiệu chỉnh 100 VU; kết quả không chứng minh khả năng chịu tải 10.000 VU.'])
lines.extend(['', 'Percentile HTTP được tính riêng theo endpoint và vai trò.',
              'Thời gian nhận diện đầu cuối bao gồm chờ và xử lý; cửa sổ tài nguyên bao gồm thời gian chờ job.',
              '', '## Môi trường, phương pháp và giới hạn', '',
              'Xem environment.json và versions.json để biết nguồn thu thập, phiên bản và cấu hình thực tế.',
              'Tỷ lệ nhận diện mục tiêu 5%; thời gian nghỉ giữa thao tác 2–5 giây; một lần đo không chứng minh độ ổn định.',
              'Dữ liệu thiếu và độ bao phủ được liệt kê trong readiness.md.',
              '', '## Độ trễ đọc theo chặng (ms)', '',
              '| Chặng | Trung bình | p95 | p99 |', '| --- | ---: | ---: | ---: |'])
for stage, item in stage_latency.items():
    lines.append(f"| {stage} | {item.get('avg', 'N/A')} | {item.get('p(95)', 'N/A')} | {item.get('p(99)', 'N/A')} |")
if not metrics and (root / 'recovered-prometheus.json').exists():
    recovered = json.loads((root / 'recovered-prometheus.json').read_text(encoding='utf-8'))
    lines.extend(['', '## Số liệu khôi phục', '',
                  f"Prometheus ghi khoảng {recovered.get('requests', 'chưa rõ')} request và {recovered.get('failures', 'chưa rõ')} lỗi nghiệp vụ. "
                  'Đây là counter khôi phục gần đúng, không thay thế summary k6; xem recovered-report.md.'])
if metadata['profile'] == 'smoke':
    lines.extend(['', '**Đây là smoke test; kết quả không chứng minh khả năng chịu tải 10.000 người dùng.**'])
(root / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    top = sorted((row for row in rows if row['p95_ms'] is not None), key=lambda row: row['p95_ms'], reverse=True)[:15]
    if top:
        fig, ax = plt.subplots(figsize=(11, max(4, len(top) * .35)))
        ax.barh([row['role'] + ': ' + row['endpoint'] for row in reversed(top)], [row['p95_ms'] for row in reversed(top)])
        ax.set_xlabel('HTTP p95 (ms)'); ax.set_title('Mixed workload: slowest role/endpoint groups')
        fig.tight_layout(); fig.savefig(root / 'latency-p95.png', dpi=150); plt.close(fig)
    seriesfile = root / 'timeseries.json'
    if seriesfile.exists():
        series = json.loads(seriesfile.read_text(encoding='utf-8'))
        fig, axes = plt.subplots(5, 1, figsize=(12, 14), sharex=True)
        for ax, name, title in zip(axes, ('vus', 'rps', 'latency_p95', 'failures', 'classifier'),
                                   ('VU', 'Request/s', 'p95 lớn nhất theo endpoint (ms)', 'Lỗi/s', 'Job nhận diện/s')):
            for item in series.get(name, {}).get('result', []):
                points = item.get('values', [])
                if points:
                    ax.plot([dt.datetime.fromtimestamp(float(p[0]), dt.timezone.utc) for p in points],
                            [float(p[1]) for p in points], label=str(item.get('metric', {}).get('outcome', name)))
            ax.set_ylabel(title); ax.grid(True, alpha=.3)
        fig.tight_layout(); fig.savefig(root / 'timeseries.png', dpi=150); plt.close(fig)
    if resources:
        host = [r for r in resources if r.get('type') == 'host' and r.get('cpu_percent') is not None]
        if host:
            fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True)
            stamp = [dt.datetime.fromtimestamp(r['timestamp'], dt.timezone.utc) for r in host]
            axes[0].plot(stamp, [r['cpu_percent'] for r in host]); axes[0].set_ylabel('CPU %')
            axes[1].plot(stamp, [r['memory_used_bytes'] / 1048576 for r in host]); axes[1].set_ylabel('RAM MiB')
            fig.tight_layout(); fig.savefig(root / 'server-resources.png', dpi=150); plt.close(fig)
    generator_samples = [r for r in genrows if r.get('cpu_percent') is not None and 'memory_used_bytes' in r]
    if generator_samples:
        fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True)
        stamp = [dt.datetime.fromtimestamp(r['timestamp'], dt.timezone.utc) for r in generator_samples]
        axes[0].plot(stamp, [r['cpu_percent'] for r in generator_samples]); axes[0].set_ylabel('CPU %')
        axes[1].plot(stamp, [r['memory_used_bytes'] / 1048576 for r in generator_samples]); axes[1].set_ylabel('RAM MiB')
        fig.tight_layout(); fig.savefig(root / 'generator-resources.png', dpi=150); plt.close(fig)
except ImportError:
    print('Matplotlib is unavailable; JSON, CSV and Markdown were generated without a plot.', file=sys.stderr)
checksums = []
for file in sorted(root.iterdir()):
    if file.is_file() and file.name != 'checksums.sha256':
        checksums.append(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.name)
(root / 'checksums.sha256').write_text('\n'.join(checksums) + '\n', encoding='utf-8')
print(f'Analysis written to {root}')
