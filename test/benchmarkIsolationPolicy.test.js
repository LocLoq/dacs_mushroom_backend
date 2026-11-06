const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('benchmark continues only when all failed isolation probes are inconclusive', { skip: process.platform !== 'win32' }, () => {
  const helper = path.resolve('benchmarks/k6/isolation-policy.ps1').replace(/'/g, "''");
  const run = data => {
    const json = JSON.stringify(data).replace(/'/g, "''");
    return spawnSync('powershell', ['-NoProfile', '-Command', `. '${helper}'; $a = '${json}' | ConvertFrom-Json; try { Assert-IsolationOutcome $a 'analysis.json' } catch { exit 1 }`], { encoding: 'utf8' }).status;
  };
  assert.equal(run({ isolation_checks: { fails: 2 }, isolation_outcomes: { inconclusive: 2, violation: 0, mismatch: 0 } }), 0);
  assert.equal(run({ isolation_checks: { fails: 1 }, isolation_outcomes: { inconclusive: 0, violation: 1, mismatch: 0 } }), 1);
  assert.equal(run({ isolation_checks: { fails: 1 }, isolation_outcomes: { inconclusive: 0, violation: 0, mismatch: 1 } }), 1);
  assert.equal(run({ isolation_checks: { fails: 1 }, isolation_outcomes: null }), 1);
});
