const { classifierConfig, retryDelay } = require('../config/classifier.cjs');

function createPythonSupervisor({ spawnChild, waitReady, config = classifierConfig(), now = Date.now,
    sleep = (ms, signal) => new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
    }), log = console.error } = {}) {
    let stopped = false;
    let child;
    let loop;
    const shutdown = new AbortController();
    const restarts = [];
    let initialResolve;
    let initialReject;
    const ready = new Promise((resolve, reject) => { initialResolve = resolve; initialReject = reject; });
    ready.catch(() => {});
    let initiallyReady = false;

    async function supervise() {
        while (!stopped) {
            let failure;
            let exited;
            let exitPromise;
            const readiness = new AbortController();
            const cancelReady = () => readiness.abort();
            shutdown.signal.addEventListener('abort', cancelReady, { once: true });
            try {
                child = spawnChild();
                exitPromise = new Promise((resolve) => {
                    let settled = false;
                    const finish = (error) => {
                        if (settled) return;
                        settled = true;
                        exited = true;
                        resolve(error);
                    };
                    child.once('exit', (code, signal) => finish(new Error(`Python classifier kết thúc với ${signal || `mã ${code}`}`)));
                    child.once('error', (error) => finish(error));
                });
                const outcome = await Promise.race([
                    waitReady(readiness.signal).then(() => ({ ready: true })),
                    exitPromise.then((error) => ({ error }))
                ]);
                if (outcome.error) throw outcome.error;
                if (stopped) break;
                if (!initiallyReady) { initiallyReady = true; initialResolve(child); }
                failure = await exitPromise;
            } catch (error) {
                failure = error;
                if (child && !exited) {
                    child.kill('SIGTERM');
                    // Do not spawn a competing service until the previous process exits.
                    await exitPromise;
                }
            } finally {
                readiness.abort();
                shutdown.signal.removeEventListener('abort', cancelReady);
                child = null;
            }
            if (stopped) break;
            const cutoff = now() - config.restartWindowMs;
            while (restarts.length && restarts[0] <= cutoff) restarts.shift();
            if (restarts.length >= config.restartLimit) {
                log('Python classifier restart limit reached:', { code: 'PYTHON_RESTART_LIMIT', message: failure?.message });
                if (!initiallyReady) initialReject(failure);
                break;
            }
            const delayMs = retryDelay(restarts.length + 1, config.restartBackoffMs);
            restarts.push(now());
            log('Restarting Python classifier:', { code: 'PYTHON_EXIT', restart: restarts.length, delayMs, message: failure?.message });
            await sleep(delayMs, shutdown.signal);
        }
        if (!initiallyReady && stopped) initialReject(new Error('Stack stopped before Python was ready'));
    }
    return {
        start() {
            if (!loop) loop = supervise().catch((error) => { log('Python supervisor failed:', error.message); initialReject(error); });
            return ready;
        },
        async stop() {
            stopped = true;
            shutdown.abort();
            child?.kill('SIGTERM');
            await loop;
        }
    };
}

module.exports = { createPythonSupervisor };
