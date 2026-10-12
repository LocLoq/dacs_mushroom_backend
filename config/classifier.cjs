function positiveInteger(environment, name, fallback) {
    const value = environment[name] === undefined ? fallback : Number(environment[name]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}

function classifierConfig(environment = process.env) {
    const timeoutMs = positiveInteger(environment, 'CLASSIFIER_TIMEOUT_MS', 120000);
    return {
        attempts: positiveInteger(environment, 'CLASSIFIER_JOB_ATTEMPTS', 3),
        backoffMs: positiveInteger(environment, 'CLASSIFIER_RETRY_BACKOFF_MS', 30000),
        healthTimeoutMs: positiveInteger(environment, 'CLASSIFIER_HEALTH_TIMEOUT_MS', 2000),
        healthCacheMs: positiveInteger(environment, 'CLASSIFIER_HEALTH_CACHE_MS', 5000),
        monitorIntervalMs: positiveInteger(environment, 'CLASSIFIER_MONITOR_INTERVAL_MS', 10000),
        enqueueTimeoutMs: positiveInteger(environment, 'CLASSIFIER_ENQUEUE_TIMEOUT_MS', 5000),
        queueWaitMs: positiveInteger(environment, 'CLASSIFIER_QUEUE_WAIT_MS', 300000),
        missingGraceMs: positiveInteger(environment, 'CLASSIFIER_MISSING_JOB_GRACE_MS', 15000),
        processingTimeoutMs: positiveInteger(environment, 'CLASSIFIER_PROCESSING_TIMEOUT_MS', timeoutMs + 30000),
        timeoutMs,
        pageSize: positiveInteger(environment, 'CLASSIFIER_MONITOR_PAGE_SIZE', 100),
        restartLimit: positiveInteger(environment, 'CLASSIFIER_RESTART_LIMIT', 3),
        restartWindowMs: positiveInteger(environment, 'CLASSIFIER_RESTART_WINDOW_MS', 300000),
        restartBackoffMs: positiveInteger(environment, 'CLASSIFIER_RESTART_BACKOFF_MS', 2000),
        startupTimeoutMs: positiveInteger(environment, 'CLASSIFIER_STARTUP_TIMEOUT_MS', 60000)
    };
}

const retryDelay = (attemptsMade, baseDelay) => baseDelay * (2 ** Math.max(0, attemptsMade - 1));
module.exports = { positiveInteger, classifierConfig, retryDelay };
