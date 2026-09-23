const fs = require('fs');
const { writeAuditLog } = require('../middlewares/audit');
const { classifyWithPythonService } = require('../services/pythonClassifierClient');

const emitLookupEvent = (lookupId, event, payload) => {
    if (global.io) global.io.to(`job_${lookupId}`).emit(event, payload);
};

const removeInputFile = async (filePath) => {
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Unable to remove classifier image:', error.message);
    }
};

function createMushroomClassifierProcessor({ prisma = global.prisma, classify = classifyWithPythonService, audit = writeAuditLog, emit = emitLookupEvent } = {}) {
    return async function sendMushroomClassifierReq(job) {
    const { lookupId, originalName, path: imagePath } = job.data;

    try {
        await prisma.classifierLookup.update({ where: { id: lookupId }, data: { status: 'PROCESSING', startedAt: new Date(), errorMessage: null } });
        emit(lookupId, 'processing', { jobId: lookupId, status: 'PROCESSING', message: `Đang xử lý ảnh: ${originalName}` });

        const serviceResult = await classify({ lookupId, imagePath, originalName, mimeType: job.data.mimeType || 'image/jpeg' });
        const result = serviceResult.result;
        await prisma.classifierLookup.update({
            where: { id: lookupId },
            data: { status: 'SUCCEEDED', result, predictedName: result.name, edibility: result.edibility, confidence: result.confidence, completedAt: new Date() }
        });
        await audit({ action: 'CLASSIFIER_COMPLETED', entityType: 'ClassifierLookup', entityId: lookupId, method: 'SYSTEM', path: 'queue:mushroomClassifier', statusCode: 200, outcome: 'SUCCESS', metadata: { predictedName: result.name, confidence: result.confidence } });
        emit(lookupId, 'finished', { jobId: lookupId, status: 'SUCCEEDED', result });
        return { success: true, result };
    } catch (error) {
        try {
            await prisma.classifierLookup.update({ where: { id: lookupId }, data: { status: 'FAILED', errorMessage: `[${error.code || 'CLASSIFIER_ERROR'}] ${error.message}`.slice(0, 2000), completedAt: new Date() } });
        } catch (persistenceError) {
            console.error('Unable to persist classifier failure:', persistenceError.message);
        }
        await audit({ action: 'CLASSIFIER_FAILED', entityType: 'ClassifierLookup', entityId: lookupId, method: 'SYSTEM', path: 'queue:mushroomClassifier', statusCode: 500, outcome: 'FAILURE', metadata: { code: error.code || 'CLASSIFIER_ERROR', error: error.message.slice(0, 500) } });
        emit(lookupId, 'failed', { jobId: lookupId, status: 'FAILED', message: 'Phân loại thất bại' });
        throw error;
    } finally {
        await removeInputFile(imagePath);
    }
    };
}

const sendMushroomClassifierReq = createMushroomClassifierProcessor();
module.exports = sendMushroomClassifierReq;
module.exports.createMushroomClassifierProcessor = createMushroomClassifierProcessor;
