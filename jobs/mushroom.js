const { writeAuditLog } = require('../middlewares/audit');
const { classifyWithPythonService } = require('../services/pythonClassifierClient');
const { classifierConfig, retryDelay } = require('../config/classifier.cjs');
const { emitLookupEvent, removeInputFile, failLookup, notify, activeRequests, abortLookup } = require('../services/classifierLifecycle');

const isRetryable = (error) => error.retryable === true || ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(error.code);

function createMushroomClassifierProcessor({ prisma = global.prisma, classify = classifyWithPythonService,
    audit = writeAuditLog, emit = emitLookupEvent, removeFile = removeInputFile,
    checkHealth = async () => {}, config = classifierConfig(), now = Date.now } = {}) {
    return async function processClassifier(job) {
        const { lookupId, originalName, path: imagePath } = job.data;
        const lookup = await prisma.classifierLookup.findUnique({ where: { id: lookupId } });
        if (!lookup) { job.discard(); throw Object.assign(new Error('Classifier lookup missing'), { code: 'LOOKUP_MISSING' }); }
        if (lookup.status === 'SUCCEEDED' || lookup.status === 'FAILED') {
            await removeFile(lookup.inputPath);
            return { success: lookup.status === 'SUCCEEDED', result: lookup.result };
        }

        // Millisecond timestamps fence older/stalled attempts, including immediate retries.
        const startedAt = new Date(Math.max(now(), lookup.startedAt ? new Date(lookup.startedAt).getTime() + 1 : 0));
        const claimed = await prisma.classifierLookup.updateMany({
            where: { id: lookupId, status: lookup.status, startedAt: lookup.startedAt || null, updatedAt: lookup.updatedAt },
            data: { status: 'PROCESSING', startedAt, errorMessage: null, completedAt: null, inputPath: lookup.inputPath || imagePath, attempt: (job.attemptsMade || 0) + 1, maxAttempts: job.opts?.attempts || config.attempts, nextRetryAt: null }
        });
        if (!claimed.count) throw Object.assign(new Error('Classifier claim changed'), { code: 'CLAIM_CHANGED', retryable: true });
        abortLookup(lookupId);
        const controller = new AbortController();
        const active = { startedAt, controller };
        activeRequests.set(lookupId, active);
        const attempt = (job.attemptsMade || 0) + 1;
        const maxAttempts = job.opts?.attempts || config.attempts;
        const owned = { id: lookupId, status: 'PROCESSING', startedAt };
        try {
            emit(lookupId, 'processing', { jobId: lookupId, status: 'PROCESSING', attempt, maxAttempts, message: `Đang xử lý ảnh: ${originalName}` });
            await checkHealth();
            const { result } = await classify({ lookupId, imagePath, originalName, mimeType: job.data.mimeType || 'image/jpeg', signal: controller.signal });
            const saved = await prisma.classifierLookup.updateMany({
                where: owned,
                data: { status: 'SUCCEEDED', result, predictedName: result.name, edibility: result.edibility, confidence: result.confidence, errorMessage: null, completedAt: new Date(now()) }
            });
            if (saved.count) {
                await notify(audit, emit, {
                    action: 'CLASSIFIER_COMPLETED', entityType: 'ClassifierLookup', entityId: lookupId,
                    method: 'SYSTEM', path: 'queue:mushroomClassifier', statusCode: 200, outcome: 'SUCCESS', metadata: { predictedName: result.name, confidence: result.confidence, attempt }
                }, 'finished', { jobId: lookupId, status: 'SUCCEEDED', result });
                await removeFile(lookup.inputPath || imagePath);
            }
            return { success: Boolean(saved.count), result: saved.count ? result : undefined };
        } catch (error) {
            const code = error.code || 'CLASSIFIER_ERROR';
            const message = String(error.message || 'Classifier error');
            const retry = isRetryable(error) && attempt < maxAttempts;
            console.error('Classifier attempt failed:', { jobId: lookupId, code, attempt, maxAttempts, retry });
            if (!retry) job.discard();
            try {
                if (retry) {
                    const changed = await prisma.classifierLookup.updateMany({
                        where: owned,
                        data: { status: 'QUEUED', nextRetryAt: new Date(now() + retryDelay(attempt, config.backoffMs)), errorMessage: `[${code}] ${message}`.slice(0, 2000), completedAt: null }
                    });
                    if (changed.count) emit(lookupId, 'retrying', { jobId: lookupId, status: 'QUEUED', attempt, maxAttempts,
                        retryDelayMs: retryDelay(attempt, config.backoffMs), message: 'Đang chờ thử lại nhận diện' });
                } else {
                    await failLookup({ prisma, lookup: { ...lookup, status: 'PROCESSING', startedAt, inputPath: lookup.inputPath || imagePath },
                        code, message, audit, emit, removeFile });
                }
            } catch (persistenceError) {
                // Leave the image for reconciliation after database/Redis recovery.
                console.error('Unable to persist classifier failure:', { jobId: lookupId, code: persistenceError.code, message: persistenceError.message });
            }
            throw error;
        } finally {
            if (activeRequests.get(lookupId) === active) activeRequests.delete(lookupId);
        }
    };
}

module.exports = createMushroomClassifierProcessor();
module.exports.createMushroomClassifierProcessor = createMushroomClassifierProcessor;
