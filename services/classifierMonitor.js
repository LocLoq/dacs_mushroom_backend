const fs = require('fs');
const path = require('path');
const { classifierConfig } = require('../config/classifier.cjs');
const { failLookup, removeInputFile, classifierUploadDirectory } = require('./classifierLifecycle');
const { withDeadline, unavailable } = require('./classifierHealth');

function createClassifierMonitor({ prisma = global.prisma, queue, config = classifierConfig(), now = Date.now,
    fail = failLookup, removeFile = removeInputFile } = {}) {
    let running = null;
    let timer;
    let stopped = false;
    let lastHealth;
    const readQueue = (operation) => withDeadline(operation, config.healthTimeoutMs,
        unavailable('QUEUE_UNAVAILABLE', 'Queue reconciliation timed out'));
    const reconcile = async (lookup, redisReady) => {
        let code;
        let message;
        const waitingSince = new Date(lookup.updatedAt || lookup.queuedAt).getTime();
        if (lookup.status === 'QUEUED' && now() - waitingSince >= config.queueWaitMs) {
            code = 'QUEUE_WAIT_TIMEOUT'; message = 'Yêu cầu chờ xử lý quá lâu';
        } else if (lookup.status === 'PROCESSING' && lookup.startedAt && now() - new Date(lookup.startedAt).getTime() >= config.processingTimeoutMs) {
            code = 'PROCESSING_TIMEOUT'; message = 'Tiến trình nhận diện bị treo hoặc quá thời gian';
        } else if (redisReady) {
            let job;
            try { job = await readQueue(() => queue.getJob(lookup.id)); } catch (_) { return; }
            if (!job && now() - waitingSince >= config.missingGraceMs) {
                code = 'QUEUE_JOB_MISSING'; message = 'Không tìm thấy yêu cầu trong hàng đợi';
            } else if (job) {
                let state;
                try { state = await readQueue(() => job.getState()); } catch (_) { return; }
                if (state === 'failed') {
                    code = 'QUEUE_JOB_FAILED'; message = 'Hàng đợi không thể xử lý yêu cầu';
                } else if (state === 'completed') {
                    code = 'QUEUE_STATE_MISMATCH'; message = 'Hàng đợi đã kết thúc nhưng chưa có kết quả nhận diện';
                }
            }
        }
        if (code) {
            const changed = await fail({ prisma, lookup, code, message, where: { updatedAt: lookup.updatedAt }, removeFile });
            if (!changed) return;
            if (redisReady) {
                try {
                    const job = await readQueue(() => queue.getJob(lookup.id));
                    if (job && ['waiting', 'delayed', 'paused', 'failed'].includes(await readQueue(() => job.getState()))) {
                        await readQueue(() => job.remove());
                    }
                } catch (_) { /* A late/active job will check the terminal database status. */ }
            }
        }
    };
    const run = () => {
        if (running) return running;
        if (stopped) return Promise.resolve();
        running = (async () => {
            const health = await queue.health.check(true);
            if (!lastHealth || health.redis !== lastHealth.redis || health.python !== lastHealth.python) {
                console.log('Classifier health:', { redis: health.redis, python: health.python });
                lastHealth = health;
            }
            let afterId;
            while (!stopped) {
                const lookups = await prisma.classifierLookup.findMany({
                    where: { status: { in: ['QUEUED', 'PROCESSING'] }, ...(afterId && { id: { gt: afterId } }) },
                    orderBy: { id: 'asc' }, take: config.pageSize
                });
                for (const lookup of lookups) {
                    if (stopped) break;
                    await reconcile(lookup, health.redis);
                }
                if (lookups.length < config.pageSize) break;
                afterId = lookups.at(-1).id;
            }
        })().catch((error) => console.error('Classifier reconciliation failed:', { code: error.code, message: error.message }))
            .finally(() => { running = null; });
        return running;
    };
    const onFailed = async (job) => {
        try {
            // Bull emits "failed" for retryable attempts too. Do not terminalize those.
            if (await readQueue(() => job.getState()) !== 'failed') return;
            const lookup = await prisma.classifierLookup.findUnique({ where: { id: job.data.lookupId } });
            if (lookup && ['QUEUED', 'PROCESSING'].includes(lookup.status)) {
                await fail({ prisma, lookup, code: 'QUEUE_JOB_FAILED', message: 'Hàng đợi không thể xử lý yêu cầu',
                    where: { updatedAt: lookup.updatedAt }, removeFile });
            }
        } catch (error) { console.error('Unable to reconcile failed classifier job:', { jobId: job.id, message: error.message }); }
    };
    return {
        run,
        start(worker) {
            worker?.on('failed', onFailed);
            void run();
            timer = setInterval(() => { void run(); }, config.monitorIntervalMs);
            timer.unref();
        },
        async stop(worker) {
            stopped = true;
            clearInterval(timer);
            worker?.removeListener('failed', onFailed);
            await running;
        }
    };
}

async function cleanStaleClassifierFiles(prisma = global.prisma, { directory = classifierUploadDirectory, removeFile = removeInputFile } = {}) {
    try {
        // Legacy in-flight jobs predate inputPath; their file ownership is not yet known.
        const legacy = await prisma.classifierLookup.findFirst({ where: { inputPath: null, status: { in: ['QUEUED', 'PROCESSING'] } }, select: { id: true } });
        if (legacy) return;
        const entries = await fs.promises.readdir(directory);
        const threshold = Date.now() - 24 * 60 * 60 * 1000;
        for (const entry of entries) {
            const filePath = path.join(directory, entry);
            const stats = await fs.promises.lstat(filePath);
            if (!stats.isFile() || stats.mtimeMs >= threshold) continue;
            const active = await prisma.classifierLookup.findFirst({ where: { inputPath: filePath, status: { in: ['QUEUED', 'PROCESSING'] } }, select: { id: true } });
            if (!active) await removeFile(filePath);
        }
    } catch (error) { console.error('Unable to clean stale classifier images:', error.message); }
}

module.exports = { createClassifierMonitor, cleanStaleClassifierFiles };
