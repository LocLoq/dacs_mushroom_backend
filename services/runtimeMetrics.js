const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
function start(name, database, queue) {
    const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
    const timer = setInterval(async () => {
        const pool = database.pool();
        const sample = { timestamp: Date.now(), pool_limit: database.limit,
            pool_active: pool?.activeConnections(), pool_idle: pool?.idleConnections(),
            pool_waiting: pool?.taskQueueSize(), event_loop_p95_ms: delay.percentile(95) / 1e6 };
        if (name === 'api') sample.cache = { enabled: require('./publicCache').publicCache().enabled, ...require('./publicCache').publicCache().metrics };
        delay.reset();
        if (queue?.client?.status === 'ready') {
            try { sample.queue = await queue.getJobCounts(); sample.admitted = await queue.client.zcard('mushroomClassifier:admission'); } catch (_) {}
        }
        try { fs.writeFileSync(`/tmp/classifier-runtime-${name}.json`, JSON.stringify(sample)); } catch (_) {}
    }, 5000);
    timer.unref();
    return () => { clearInterval(timer); delay.disable(); };
}
module.exports = { start };
