const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResourceSafety } = require('../benchmarks/k6/resource-safety.cjs');

test('unhealthy or missing API does not stop a benchmark, including prolonged unavailability', () => {
  const warnings = [];
  const check = createResourceSafety({ warn: message => warnings.push(message) });
  const health = { type: 'health', service: 'api', status: 'running', health: 'unhealthy', restart_count: 0 };
  for (let i = 0; i < 30; i++) assert.equal(check(health), null);
  assert.equal(check({ type: 'container_change', services: ['db'] }), null);
  assert.equal(check({ ...health, health: 'healthy' }), null);
  assert.deepEqual(warnings, ['API is unhealthy; benchmark continues', 'API recovered']);
});

test('OOM and container restart still request a safety stop', () => {
  const check = createResourceSafety({ warn: () => {} });
  assert.equal(check({ type: 'health', service: 'api', status: 'running', restart_count: 0 }), null);
  assert.match(check({ type: 'health', service: 'api', status: 'running', restart_count: 1 }), /restarted/);
  assert.match(check({ type: 'health', service: 'db', oom_killed: true }), /OOM/);
});
