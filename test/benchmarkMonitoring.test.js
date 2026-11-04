const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { monitoring, queryRange } = require('../benchmarks/k6/report-metadata.cjs');

test('monitoring reads version and time series without retaining unrelated fields', async t => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/v1/status/buildinfo')) return res.end(JSON.stringify({ data: { version: '3.0', revision: 'abc', secret: 'hidden' } }));
    if (req.url.startsWith('/api/health')) return res.end(JSON.stringify({ version: '12.0', commit: 'xyz', secret: 'hidden' }));
    if (req.url.startsWith('/api/v1/query_range')) return res.end(JSON.stringify({ status: 'success', data: { result: [] } }));
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const info = await monitoring(base, base);
  assert.equal(info.prometheus.value.version, '3.0');
  assert.equal(info.grafana.value.version, '12.0');
  assert.equal(JSON.stringify(info).includes('hidden'), false);
  assert.deepEqual(await queryRange(base, 'up', 1, 10), { result: [] });
  assert.equal((await monitoring('http://user:password@127.0.0.1', base)).prometheus.status, 'unavailable');
});
