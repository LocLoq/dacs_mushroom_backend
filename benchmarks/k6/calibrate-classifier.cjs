const fs = require('node:fs');
const concurrency = Number(process.env.CLASSIFIER_CALIBRATION_CONCURRENCY || 1);
const image = fs.readFileSync('/app/fixture.jpg');
async function run(seconds) {
    const started = Date.now(), end = started + seconds * 1000, durations = [];
    let errors = 0;
    async function client() {
        while (Date.now() < end) {
            const form = new FormData();
            form.append('requestId', 'calibration'); form.append('image', new Blob([image], { type: 'image/jpeg' }), 'fixture.jpg');
            const start = Date.now();
            try {
                const response = await fetch('http://classifier:8001/v1/classify', { method: 'POST', body: form,
                    headers: { 'x-classifier-token': process.env.CLASSIFIER_SERVICE_TOKEN }, signal: AbortSignal.timeout(120000) });
                if (!response.ok) throw Error('classifier response');
                await response.arrayBuffer(); durations.push(Date.now() - start);
            } catch (_) { errors++; }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, client));
    durations.sort((a, b) => a - b);
    const elapsed = (Date.now() - started) / 1000;
    return { seconds, elapsed_seconds: elapsed, succeeded: durations.length, errors, throughput: durations.length / elapsed,
        p95_ms: durations.length ? durations[Math.ceil(durations.length * .95) - 1] : null };
}
(async () => { await run(30); const result = await run(120); console.log(JSON.stringify(result)); if (!result.succeeded || result.errors) process.exitCode = 1; })().catch(() => { process.exitCode = 1; });
