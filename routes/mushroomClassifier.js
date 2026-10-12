const { fail, pagination, pageResponse, fields, textField, dateField, handle, errorHandler } = require('../services/apiHelpers');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const multer = require('multer');

const { auditAction } = require('../middlewares/audit');
const { optionalAuthenticateToken, authenticateToken, authorizeRoles } = require('../middlewares/auth');
const mushroomClassifierQueue = require('../queues/mushroomClassifierQueue');
const { getRateLimiters } = require('../middlewares/rateLimit');
const { classifierUploadDirectory, removeInputFile: removeFile, failLookup } = require('../services/classifierLifecycle');
const { withDeadline, unavailable } = require('../services/classifierHealth');

const router = express.Router();
const prisma = global.prisma;
const imageExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const lookupStatuses = new Set(['QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED']);

fs.mkdirSync(classifierUploadDirectory, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: classifierUploadDirectory,
        filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}${imageExtensions[file.mimetype]}`)
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, callback) => {
        if (!imageExtensions[file.mimetype]) return callback(new Error('Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP'));
        callback(null, true);
    }
});

const historySelect = {
    id: true, originalName: true, mimeType: true, fileSize: true, status: true,
    predictedName: true, edibility: true, confidence: true, errorMessage: true,
    queuedAt: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true,
    user: { select: { id: true, username: true, full_name: true } }
};

router.post('/classify', auditAction('CLASSIFIER_SUBMIT', {
    entityType: 'ClassifierLookup',
    entityId: (req, res) => res.locals.classifierLookupId || null,
    metadata: (req) => ({ hasImage: Boolean(req.file) })
}), getRateLimiters().classifier, optionalAuthenticateToken,
handle(async (req, res, next) => { await mushroomClassifierQueue.health.assertReady(); next(); }),
upload.single('image'), handle(async (req, res) => {
    let accepted = false;
    try {
        if (!req.file) fail(400, 'Vui lòng đính kèm ảnh nấm');
        fields(req.body || {}, [], { allowEmpty: true });

        const lookup = await prisma.classifierLookup.create({
            data: { userId: req.user?.id || null, originalName: req.file.originalname, mimeType: req.file.mimetype, fileSize: req.file.size, inputPath: req.file.path }
        });
        res.locals.classifierLookupId = lookup.id;
        // Database ownership survives an enqueue/persistence outage. The monitor cleans it.
        res.locals.classifierOwnsInput = true;

        try {
            await withDeadline(() => mushroomClassifierQueue.add({ lookupId: lookup.id, originalName: req.file.originalname, mimeType: req.file.mimetype, path: req.file.path }, { jobId: lookup.id }),
                mushroomClassifierQueue.classifierConfig.enqueueTimeoutMs, unavailable('QUEUE_UNAVAILABLE', 'Hàng đợi nhận diện không phản hồi'));
        } catch (queueError) {
            console.error('Classifier enqueue failed:', { jobId: lookup.id, code: queueError.code || 'QUEUE_UNAVAILABLE' });
            // An enqueue acknowledgement may be lost after the worker has already claimed it.
            for (let attempt = 0; attempt < 3; attempt++) {
                const current = await prisma.classifierLookup.findUnique({ where: { id: lookup.id } });
                if (!current || ['SUCCEEDED', 'FAILED'].includes(current.status)) break;
                if (await failLookup({ prisma, lookup: { ...current, inputPath: req.file.path }, code: 'QUEUE_UNAVAILABLE',
                    message: 'Không thể đưa yêu cầu vào hàng đợi', where: { updatedAt: current.updatedAt } })) break;
            }
            fail(503, 'Không thể tiếp nhận yêu cầu phân loại', 'QUEUE_UNAVAILABLE');
        }

        accepted = true;
        res.status(202).json({ jobId: lookup.id, status: lookup.status });
    } catch (error) {
        if (!res.locals.classifierOwnsInput) await removeFile(req.file?.path);
        if (error.status || accepted) throw error;
        console.error('Error in classifier route:', error);
        fail(503, 'Không thể tiếp nhận yêu cầu phân loại');
    }
}));

router.get('/history', auditAction('CLASSIFIER_HISTORY_VIEW', { entityType: 'ClassifierLookup' }), authenticateToken, authorizeRoles(...global.privilegedRoles), handle(async (req, res) => {
    const paging = pagination(req.query, 100, 20);
    const { limit, skip } = paging;
    const from = req.query.from === undefined ? undefined : dateField(req.query.from, 'from');
    const to = req.query.to === undefined ? undefined : dateField(req.query.to, 'to');
    if ((from && to && from > to) || (req.query.status !== undefined && !lookupStatuses.has(req.query.status))) {
        fail(400, 'Bộ lọc lịch sử không hợp lệ');
    }

    const where = {
        ...(req.query.status && { status: req.query.status }),
        ...(req.query.predictedName && { predictedName: { contains: textField(req.query.predictedName, 'predictedName', Infinity) } }),
        ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } })
    };
    const [totalItems, data] = await Promise.all([
        prisma.classifierLookup.count({ where }),
        prisma.classifierLookup.findMany({ where, select: historySelect, skip, take: limit, orderBy: { createdAt: 'desc' } })
    ]);

    res.json(pageResponse(data, totalItems, paging));
}));

router.get('/history/:id', auditAction('CLASSIFIER_HISTORY_DETAIL_VIEW', { entityType: 'ClassifierLookup', entityId: (req) => req.params.id }), authenticateToken, authorizeRoles(...global.privilegedRoles), handle(async (req, res) => {
    const lookup = await prisma.classifierLookup.findUnique({ where: { id: req.params.id }, select: { ...historySelect, result: true } });
    if (!lookup) fail(404, 'Không tìm thấy lượt tra cứu');
    res.json({ data: lookup });
}));

router.use(async (error, req, res, next) => {
    if (!res.locals.classifierOwnsInput) await removeFile(req.file?.path);
    if (error instanceof multer.MulterError) return errorHandler({ status: 400, message: error.code === 'LIMIT_FILE_SIZE' ? 'Ảnh không được vượt quá 5 MB' : 'Chỉ được đính kèm một ảnh' }, req, res, next);
    if (error.message === 'Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP') return errorHandler({ status: 400, message: error.message }, req, res, next);
    next(error);
});

module.exports = router;
