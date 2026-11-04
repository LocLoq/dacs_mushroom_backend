import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ANALYZER = Path(__file__).resolve().parents[1] / 'benchmarks' / 'k6' / 'analyze-results.py'


class BenchmarkReportTest(unittest.TestCase):
    def test_complete_evidence_can_be_ready_even_when_threshold_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = {'api': ['runtime', 'npm', 'node_dependencies', 'source_hash', 'database_runtime', 'os_packages'],
                     'db': ['server', 'os_packages'], 'redis': ['server', 'os_packages'],
                     'classifier': ['python', 'python_dependencies', 'model_hashes', 'model_runtime', 'os_packages']}
            services = [{'service': name, 'image_id': name, 'state': {'restart_count': 0}, 'config': {},
                         'versions': {key: {'exit_code': 0, 'stdout': 'observed'} for key in fields}} for name, fields in names.items()]
            server = {'cpu_count': 4, 'memory': {'MemTotal': 1024}, 'os_release': {'exit_code': 0},
                      'disk': {'exit_code': 0}, 'containers': services}
            start = '2026-01-01T00:00:00Z'; end = '2026-01-01T00:00:10Z'; epoch = 1767225600
            metadata = {'schema_version': 2, 'run_id': 'testrun', 'profile': 'full', 'mode': 'realistic', 'roles': {},
                        'base_url': 'http://127.0.0.1', 'source_ips': 'local', 'source_ip_count_declared': 1,
                        'rate_limits_declared': {}, 'sampler': 'ssh', 'server': server, 'server_after': server,
                        'effective_api': {'mode': 'production'}, 'finished_at': end,
                        'generator': {'system': {'platform': 'linux'}, 'k6': 'k6', 'script_sha256': 'a', 'seed_sha256': 'b', 'image_sha256': 'c'},
                        'monitoring': {'prometheus': {'status': 'ok'}, 'grafana': {'status': 'ok'}},
                        'runs': [{'id': name, 'exit_code': 0, 'started_at': start, 'finished_at': end} for name in ('preflight', 'warmup', 'measured')]}
            (root / 'metadata.json').write_text(json.dumps(metadata), encoding='utf-8')
            core = ('http_req_duration{phase:business,kind:read}', 'http_req_failed{phase:business}', 'checks{phase:business}')
            metrics = {name: {'values': {}, 'thresholds': {'threshold': {'ok': name != core[0]}}} for name in core}
            for phase in ('preflight', 'warmup', 'measured'):
                values = dict(metrics) if phase == 'measured' else {'business_requests{endpoint:species_list,role:guest}': {'values': {'count': 1}, 'thresholds': {'count>0': {'ok': True}}}}
                (root / (phase + '.summary.json')).write_text(json.dumps({'metrics': values}), encoding='utf-8')
            (root / 'resources.ndjson').write_text(''.join(json.dumps({'type': 'host', 'timestamp': epoch + i, 'memory_used_bytes': 1}) + '\n' for i in range(11)), encoding='utf-8')
            (root / 'generator-resources.ndjson').write_text(''.join(json.dumps({'timestamp': epoch + i, 'cpu_percent': 5}) + '\n' for i in range(11)) + ''.join(json.dumps({'type': 'io', 'timestamp': epoch + i}) + '\n' for i in (0, 5, 10)), encoding='utf-8')
            series = {name: {'result': []} for name in ('rps', 'latency_p95', 'failures', 'classifier')}
            series['vus'] = {'result': [{'values': [[epoch + i, '1'] for i in (0, 5, 10)]}]}
            (root / 'timeseries.json').write_text(json.dumps(series), encoding='utf-8')
            result = subprocess.run([sys.executable, str(ANALYZER), str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            readiness = json.loads((root / 'readiness.json').read_text(encoding='utf-8'))
            self.assertTrue(readiness['ready'], readiness['missing'])
            self.assertFalse(readiness['performance_passed'])

    def test_partial_and_legacy_results_are_reported_without_inventing_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = {'run_id': 'oldrun', 'profile': 'smoke', 'mode': 'realistic', 'roles': {},
                        'base_url': 'http://127.0.0.1', 'source_ips': 'unknown', 'rate_limits_declared': {},
                        'runs': [], 'incomplete': True}
            (root / 'metadata.json').write_text(json.dumps(metadata), encoding='utf-8')
            result = subprocess.run([sys.executable, str(ANALYZER), str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            readiness = json.loads((root / 'readiness.json').read_text(encoding='utf-8'))
            self.assertFalse(readiness['ready'])
            self.assertIsNone(readiness['performance_passed'])
            self.assertTrue(any('Metadata' in item for item in readiness['missing']))
            self.assertTrue((root / 'checksums.sha256').exists())
            self.assertNotIn('node:', (root / 'versions.json').read_text(encoding='utf-8'))

    def test_failed_threshold_is_separate_from_missing_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = {'schema_version': 2, 'run_id': 'testrun', 'profile': 'smoke', 'mode': 'realistic',
                        'roles': {}, 'base_url': 'http://127.0.0.1', 'source_ips': 'local', 'rate_limits_declared': {},
                        'runs': [], 'finished_at': '2026-01-01T00:00:10Z'}
            (root / 'metadata.json').write_text(json.dumps(metadata), encoding='utf-8')
            names = ('http_req_duration{phase:business,kind:read}', 'http_req_failed{phase:business}', 'checks{phase:business}')
            metrics = {name: {'values': {}, 'thresholds': {'threshold': {'ok': name != names[0]}}} for name in names}
            (root / 'measured.summary.json').write_text(json.dumps({'metrics': metrics}), encoding='utf-8')
            result = subprocess.run([sys.executable, str(ANALYZER), str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            readiness = json.loads((root / 'readiness.json').read_text(encoding='utf-8'))
            self.assertFalse(readiness['ready'])
            self.assertFalse(readiness['performance_passed'])


if __name__ == '__main__':
    unittest.main()
