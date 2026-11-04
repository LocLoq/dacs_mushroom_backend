const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('smoke gate tolerates only incomplete Prometheus VU sampling', { skip: process.platform !== 'win32' }, () => {
    const helper = path.resolve('benchmarks/k6/smoke-readiness.ps1').replace(/'/g, "''");
    const invoke = (value) => {
        const json = JSON.stringify(value).replace(/'/g, "''");
        return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            `. '${helper}'; $r = '${json}' | ConvertFrom-Json; try { Assert-SmokeReadiness $r } catch { exit 1 }`], { encoding: 'utf8' });
    };
    assert.equal(invoke({ ready: true, missing: [] }).status, 0);
    assert.equal(invoke({ ready: false, missing: ['time coverage prometheus_vus (>=95%, gap <=15 seconds)'] }).status, 0);
    assert.equal(invoke({ ready: false, missing: ['monitoring unavailable'] }).status, 1);
    assert.equal(invoke({ ready: false, missing: [] }).status, 1);
    assert.equal(invoke({ ready: false, missing: ['time coverage prometheus_vus (>=95%, gap <=15 seconds)', 'monitoring unavailable'] }).status, 1);
});
