const fs = require('fs');
const path = require('path');
const { writeAuditLog } = require('../middlewares/audit');

const classifierUploadDirectory = path.resolve(__dirname, '..', 'uploads', 'classifier');
const activeRequests = new Map();
const sameAttempt = (a, b) => a && b && new Date(a).getTime() === new Date(b).getTime();
const emitLookupEvent = (lookupId, event, payload) => {
    try { if (global.io) global.io.to(`job_${lookupId}`).emit('refresh', { resource: 'classifier-job', id: lookupId }); }
    catch (error) { console.error('Classifier event failed:', { jobId: lookupId, message: error.message }); }
};

async function removeInputFile(filePath) {
    if (!filePath) return;
    const directory = path.dirname(path.resolve(filePath));
    const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(directory) !== normalize(classifierUploadDirectory)) {
        console.error('Refusing to remove classifier image outside upload directory');
        return;
    }
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Unable to remove classifier image:', error.message);
    }
}

async function notify(audit, emit, entry, event, payload) {
    try { await audit(entry); } catch (error) { console.error('Classifier audit failed:', error.message); }
    try { emit(entry.entityId, event, payload); } catch (error) { console.error('Classifier event failed:', error.message); }
}

function abortLookup(lookupId, startedAt) {
    const active = activeRequests.get(lookupId);
    if (active && (!startedAt || sameAttempt(active.startedAt, startedAt))) active.controller.abort();
}

async function failLookup({ prisma = global.prisma, lookup, code, message, where,
    audit = writeAuditLog, emit = emitLookupEvent, removeFile = removeInputFile }) {
    const changed = await prisma.classifierLookup.updateMany({
        where: { id: lookup.id, status: lookup.status, startedAt: lookup.startedAt || null, ...where },
        data: { status: 'FAILED', nextRetryAt: null, errorMessage: `[${code}] ${message}`.slice(0, 2000), completedAt: new Date() }
    });
    if (!changed.count) return false;
    abortLookup(lookup.id, lookup.startedAt);
    console.error('Classifier job failed:', { jobId: lookup.id, code });
    await notify(audit, emit, {
        action: 'CLASSIFIER_FAILED', entityType: 'ClassifierLookup', entityId: lookup.id,
        method: 'SYSTEM', path: 'queue:mushroomClassifier', statusCode: 500, outcome: 'FAILURE', metadata: { code }
    }, 'failed', { jobId: lookup.id, status: 'FAILED', code, message: 'Phân loại thất bại' });
    await removeFile(lookup.inputPath);
    return true;
}

module.exports = { classifierUploadDirectory, removeInputFile, emitLookupEvent, activeRequests, abortLookup, failLookup, notify };
