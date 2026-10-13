const { workflowTransaction } = require('../services/access');
const { fail, id: parseId, pagination, pageResponse, fields, textField, dateField, numberField, handle, errorHandler } = require('../services/apiHelpers');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createBatchWithCode } = require('../services/batchCode');
const router = express.Router();

const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const prisma = global.prisma;
const { batchScope, requireBatchAccess, batchAccessMiddleware } = require('../services/access');
const { refreshBatch, refreshUsers } = require('../services/workflowEvents');
const { notifyUsers, publishNotifications } = require('../services/notifications');
router.use(require('./staffAssignments').createStaffRouter('batch'));
const { createGalleryRouter } = require('./gallery');
const { galleryInclude, withGallery, removeStoredMedia } = require('../services/gallery');
// Resolve the exact batch code from a QR before opening an authenticated batch.
router.get(['/by-code', '/by-code/:batchCode'], authenticateToken, authorizeRoles(...global.allRoles), handle(async (req, res) => {
    const batchCode = textField(req.params.batchCode, 'Mã lô', 191);
    const batch = await prisma.cultivationBatch.findUnique({ where: { batchCode }, select: { id: true, batchCode: true } });
    if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');
    await requireBatchAccess(prisma, req.user, batch.id);
    res.json({ data: batch });
}));

router.use(require('./batchFinancials'));
router.use(createGalleryRouter('cultivationBatch', 'batchImage', 'batchId'));

const validateBatchData = (data) => {
    const allowed = ['batchCode', 'facilityId', 'mushroomId', 'status', 'substrateType', 'spawnSource', 'bagQuantity', 'startDate', 'expectedHarvestDate', 'endDate', 'actualYieldKg', 'defectRate', 'notes'];
    fields(data, allowed);
    for (const field of ['facilityId', 'mushroomId']) if (data[field] !== undefined) data[field] = parseId(data[field]);
    if (data.batchCode !== undefined) data.batchCode = textField(data.batchCode, 'batchCode', 191);
    if (data.status !== undefined && !['PREPARATION', 'INCUBATION', 'FRUITING', 'HARVESTING', 'COMPLETED', 'FAILED'].includes(data.status)) fail(400, 'Trạng thái lô không hợp lệ');
    for (const field of ['substrateType', 'spawnSource', 'notes']) if (data[field] !== undefined) data[field] = textField(data[field], field, Infinity, true);
    if (data.startDate === null) fail(400, 'startDate không hợp lệ');
    for (const field of ['startDate', 'expectedHarvestDate', 'endDate']) if (data[field] !== undefined && data[field] !== null) {
        data[field] = dateField(data[field], field);
    }
    if (data.bagQuantity !== undefined && data.bagQuantity !== null) {
        data.bagQuantity = numberField(data.bagQuantity, 'bagQuantity', { min: 0, integer: true });
    }
    if (data.defectRate !== undefined && data.defectRate !== null) {
        data.defectRate = numberField(data.defectRate, 'defectRate', { min: 0, max: 100 });
    }
    if (data.actualYieldKg !== undefined) data.actualYieldKg = numberField(data.actualYieldKg, 'actualYieldKg', { min: 0, nullable: true });
};

const growthProgressUploadDirectory = path.join(__dirname, '..', 'uploads', 'growth-progress');
const growthProgressImageExtensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
};

fs.mkdirSync(growthProgressUploadDirectory, { recursive: true });

const growthProgressUpload = multer({
    storage: multer.diskStorage({
        destination: growthProgressUploadDirectory,
        filename: (req, file, callback) => callback(
            null,
            `${crypto.randomUUID()}${growthProgressImageExtensions[file.mimetype]}`
        )
    }),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 5
    },
    fileFilter: (req, file, callback) => {
        if (!growthProgressImageExtensions[file.mimetype]) {
            return callback(new Error('Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP'));
        }
        callback(null, true);
    }
});

const careUploadDirectory = path.join(__dirname, '..', 'uploads', 'care-logs');
fs.mkdirSync(careUploadDirectory, { recursive: true });
const careUpload = multer({
    storage: multer.diskStorage({ destination: careUploadDirectory, filename: (req, file, callback) => callback(null, crypto.randomUUID() + growthProgressImageExtensions[file.mimetype]) }),
    limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 3 },
    fileFilter: (req, file, callback) => callback(growthProgressImageExtensions[file.mimetype] ? null : new Error('Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP'), Boolean(growthProgressImageExtensions[file.mimetype]))
}).array('images', 5);

const toGrowthProgressImageData = (files = []) => files.map((file) => ({
    imageUrl: `/uploads/growth-progress/${file.filename}`,
    originalName: file.originalname,
    mimeType: file.mimetype,
    fileSize: file.size
}));

const removeGrowthProgressUploadFiles = async (files = []) => {
    await Promise.all(files.map(async (file) => {
        try {
            await fs.promises.unlink(file.path);
        } catch (error) {
            if (error.code !== 'ENOENT') console.error(error);
        }
    }));
};

// 1. GET / - Lấy danh sách lô nuôi trồng (có phân trang và bộ lọc)
router.get('/', authenticateToken, authorizeRoles(...global.allRoles), handle(async (req, res) => {
    const paging = pagination(req.query, 50, 10);
    const { limit, skip } = paging;
    const search = req.query.search === undefined ? '' : textField(req.query.search, 'search', Infinity, true);
    const facilityId = req.query.facilityId === undefined ? undefined : parseId(req.query.facilityId);
    const mushroomId = req.query.mushroomId === undefined ? undefined : parseId(req.query.mushroomId);
    const status = req.query.status;
    if (status !== undefined && !['PREPARATION', 'INCUBATION', 'FRUITING', 'HARVESTING', 'COMPLETED', 'FAILED'].includes(status)) fail(400, 'Trạng thái lô không hợp lệ');

    const whereClause = {
        ...batchScope(req.user),
        ...(search && { batchCode: { contains: search } }),
        ...(facilityId && { facilityId }),
        ...(mushroomId && { mushroomId }),
        ...(status && { status })
    };

    const totalItems = await prisma.cultivationBatch.count({ where: whereClause });
    const batches = await prisma.cultivationBatch.findMany({
        where: whereClause,
        skip,
        take: limit,
        include: {
            ...galleryInclude,
            facility: {
                select: { id: true, name: true, facilityType: true }
            },
            mushroom: {
                select: { id: true, scientificName: true, commonName: true }
            }
        },
        orderBy: { startDate: 'desc' }
    });

    res.json(pageResponse(batches.map(withGallery), totalItems, paging));
}));

// 2. GET /:id - Lấy chi tiết 1 lô nuôi trồng
router.get('/:id', authenticateToken, authorizeRoles(...global.allRoles), batchAccessMiddleware, handle(async (req, res) => {
    const id = parseId(req.params.id);
    const batch = await prisma.cultivationBatch.findUnique({
        where: { id },
        include: {
            ...galleryInclude,
            facility: true,
            mushroom: true
        }
    });

    if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');

    res.json({ data: withGallery(batch) });
}));

// 3. POST / - Thêm lô nuôi trồng mới
router.post('/', authenticateToken, authorizeRoles(...global.privilegedRoles), handle(async (req, res) => {
    const batchData = req.body;
    validateBatchData(batchData);

    if (batchData.batchCode !== undefined) fail(400, 'Mã lô được cấp tự động');
    for (const field of ['facilityId', 'mushroomId', 'startDate']) if (batchData[field] === undefined) fail(400, `${field} là bắt buộc`);
    const newBatch = await createBatchWithCode(prisma, batchData);

    await refreshBatch(newBatch.id);
    res.status(201).json({ message: 'Thêm lô nuôi trồng thành công', data: newBatch });
}));

// 3a. GET /:id/care-logs - Nhật ký chấm sóc
router.get('/:id/care-logs', authenticateToken, authorizeRoles(...global.allRoles), batchAccessMiddleware, handle(async (req, res) => {
    const batchId = parseId(req.params.id);
    const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });

    if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');

    const careLogs = await prisma.cultivationCareLog.findMany({
        where: { batchId },
        orderBy: { recordedAt: 'desc' }
    });

    res.json({ data: careLogs });
}));

router.post('/:id/care-logs', authenticateToken, authorizeRoles(...global.allRoles), batchAccessMiddleware, careUpload, handle(async (req, res) => {
    let committed = false;
    try {
        const batchId = parseId(req.params.id);
        fields(req.body, ['actionType', 'notes', 'recordedAt']);
        const actionType = textField(req.body.actionType, 'actionType', 255);
        const notes = textField(req.body.notes, 'notes', Infinity);
        const recordedAt = req.body.recordedAt === undefined ? new Date() : dateField(req.body.recordedAt, 'recordedAt');
        const careLog = await workflowTransaction(prisma, async (tx) => {
            await requireBatchAccess(tx, req.user, batchId, true);
            return tx.cultivationCareLog.create({ data: { batchId, actionType, notes, recordedAt, createdByUserId: req.user.id, updatedByUserId: req.user.id,
                images: { create: (req.files || []).map((file) => ({ imageUrl: '/uploads/care-logs/' + file.filename, originalName: file.originalname, mimeType: file.mimetype, fileSize: file.size })) }
            }, include: { images: true } });
        });
        committed = true;
        await refreshBatch(batchId, 'care-logs');
        res.status(201).json({ message: 'Ghi nhật ký chăm sóc thành công', data: careLog });
    } catch (error) {
        if (!committed) await removeGrowthProgressUploadFiles(req.files || []);
        throw error;
    }
}));

// Growth-progress handlers keep upload cleanup inside the shared error boundary.
router.get('/:id/growth-progress', authenticateToken, authorizeRoles(...global.allRoles), batchAccessMiddleware, handle(async (req, res) => {
    const batchId = parseId(req.params.id);
    const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });
    if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');
    const growthRecords = await prisma.growthProgressRecord.findMany({
        where: { batchId }, include: { images: true }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }]
    });
    res.json({ data: growthRecords });
}));

router.post('/:id/growth-progress', authenticateToken, authorizeRoles(...global.allRoles), batchAccessMiddleware, growthProgressUpload.array('images', 5), handle(async (req, res) => {
    let committed = false;
    try {
        const uploadedFiles = req.files || [];
        const batchId = parseId(req.params.id);
        fields(req.body, ['stage', 'notes', 'recordedAt']);
        const stage = textField(req.body.stage, 'stage', Infinity);
        const notes = textField(req.body.notes, 'notes', Infinity);
        const recordedAt = req.body.recordedAt === undefined ? new Date() : dateField(req.body.recordedAt, 'recordedAt');
        const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });
        if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');
        const record = await workflowTransaction(prisma, async (tx) => {
            await requireBatchAccess(tx, req.user, batchId, true);
            return tx.growthProgressRecord.create({
            data: {
                batchId, stage, notes, recordedAt,
                createdByUserId: req.user.id, updatedByUserId: req.user.id,
                ...(uploadedFiles.length > 0 && { images: { create: toGrowthProgressImageData(uploadedFiles) } })
            },
            include: { images: true }
            });
        });
        committed = true;
        await refreshBatch(batchId, 'growth-progress');
        res.status(201).json({ message: 'Cập nhật quá trình sinh trưởng thành công', data: record });
    } catch (error) {
        if (!committed) await removeGrowthProgressUploadFiles(req.files || []);
        throw error;
    }
}));

router.patch('/:id/growth-progress/:recordId', authenticateToken, authorizeRoles(...global.allRoles), batchAccessMiddleware, growthProgressUpload.array('images', 5), handle(async (req, res) => {
    let committed = false;
    try {
        const uploadedFiles = req.files || [];
        const batchId = parseId(req.params.id);
        const recordId = parseId(req.params.recordId);
        const requestData = req.body || {};
        fields(requestData, ['stage', 'notes', 'recordedAt'], { allowEmpty: uploadedFiles.length > 0 });
        const updateData = { updatedByUserId: req.user.id };
        for (const field of ['stage', 'notes']) if (Object.hasOwn(requestData, field)) updateData[field] = textField(requestData[field], field, Infinity);
        if (Object.hasOwn(requestData, 'recordedAt')) updateData.recordedAt = dateField(requestData.recordedAt, 'recordedAt');
        const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });
        if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');
        const updatedRecord = await workflowTransaction(prisma, async (tx) => {
            await requireBatchAccess(tx, req.user, batchId, true);
            const existingRecord = await tx.growthProgressRecord.findFirst({ where: { id: recordId, batchId } });
            if (!existingRecord) fail(404, 'Không tìm thấy bản ghi quá trình sinh trưởng');
            if (req.user.role === 'staff' && existingRecord.createdByUserId !== req.user.id) fail(403, 'Chỉ được sửa bản ghi do bạn tạo');
            if (uploadedFiles.length) updateData.images = { create: toGrowthProgressImageData(uploadedFiles) };
            return tx.growthProgressRecord.update({ where: { id: recordId }, data: updateData, include: { images: true } });
        });
        committed = true;
        await refreshBatch(batchId, 'growth-progress');
        res.json({ message: 'Cập nhật quá trình sinh trưởng thành công', data: updatedRecord });
    } catch (error) {
        if (!committed) await removeGrowthProgressUploadFiles(req.files || []);
        throw error;
    }
}));

// 3c. GET /:id/harvests - Nhật ký thu hoạch
router.get('/:id/harvests', authenticateToken, authorizeRoles(...global.allRoles), batchAccessMiddleware, handle(async (req, res) => {
    const batchId = parseId(req.params.id);
    const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });

    if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');

    const harvests = await prisma.harvestRecord.findMany({
        where: { batchId },
        orderBy: { harvestedAt: 'desc' }
    });

    res.json({ data: harvests });
}));

router.post('/:id/harvests', authenticateToken, authorizeRoles(...global.allRoles), batchAccessMiddleware, handle(async (req, res) => {
    const batchId = parseId(req.params.id);
    fields(req.body, ['totalYieldKg', 'qualityGrade', 'notes', 'harvestedAt', 'finalizeBatch']);
    const { totalYieldKg, qualityGrade, notes, harvestedAt, finalizeBatch } = req.body;

    const parsedYield = numberField(totalYieldKg, 'totalYieldKg', { min: 0 });
    if (finalizeBatch !== undefined && typeof finalizeBatch !== 'boolean') fail(400, 'finalizeBatch phải là boolean');
    const parsedHarvestedAt = harvestedAt === undefined ? new Date() : dateField(harvestedAt, 'harvestedAt');
    const parsedQuality = qualityGrade === undefined ? null : textField(qualityGrade, 'qualityGrade', Infinity, true);
    const parsedNotes = notes === undefined ? null : textField(notes, 'notes', Infinity, true);

    const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });
    if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');

    const harvest = await workflowTransaction(prisma, async (tx) => {
        await requireBatchAccess(tx, req.user, batchId, true);
        const locked = await tx.cultivationBatch.updateMany({ where: { id: batchId }, data: { updatedAt: new Date() } });
        if (!locked.count) return null;
        const created = await tx.harvestRecord.create({
            data: {
                batchId,
                totalYieldKg: parsedYield,
                createdByUserId: req.user.id,
                updatedByUserId: req.user.id,
                qualityGrade: parsedQuality,
                notes: parsedNotes,
                harvestedAt: parsedHarvestedAt
            }
        });

        if (finalizeBatch) {
            const totals = await tx.harvestRecord.aggregate({ where: { batchId }, _sum: { totalYieldKg: true } });
            await tx.cultivationBatch.update({
                where: { id: batchId },
                data: {
                    status: 'COMPLETED',
                    actualYieldKg: totals._sum.totalYieldKg || 0,
                    endDate: new Date()
                }
            });
        }

        return created;
    });

    if (!harvest) fail(404, 'Không tìm thấy lô nuôi trồng');

    await refreshBatch(batchId, 'harvests');
    await refreshBatch(batchId);
    res.status(201).json({ message: 'Ghi nhận kết quả thu hoạch thành công', data: harvest });
}));

// 4. PUT /:id - Cập nhật thông tin lô nuôi trồng
router.put('/:id', authenticateToken, authorizeRoles(...global.allRoles), batchAccessMiddleware, handle(async (req, res) => {
    const id = parseId(req.params.id);
    const batchData = req.body;
    if (req.user.role === 'staff') fields(batchData, ['status']);
    validateBatchData(batchData);

    if (batchData.batchCode !== undefined) {
        const existing = await prisma.cultivationBatch.findUnique({ where: { id }, select: { batchCode: true } });
        if (!existing) fail(404, 'Không tìm thấy lô nuôi trồng');
        if (batchData.batchCode !== existing.batchCode) fail(400, 'Không được thay đổi mã lô');
        delete batchData.batchCode;
    }
    const { updatedBatch, revoked, notifications } = await workflowTransaction(prisma, async (tx) => {
        const existing = await requireBatchAccess(tx, req.user, id, true);
        const revoked = batchData.facilityId !== undefined && batchData.facilityId !== existing.facilityId
            ? await tx.batchStaff.findMany({ where: { batchId: id } }) : [];
        if (revoked.length) await tx.batchStaff.deleteMany({ where: { batchId: id } });
        const updatedBatch = await tx.cultivationBatch.update({ where: { id }, data: batchData, include: { facility: true, mushroom: true } });
        const notifications = revoked.length ? await notifyUsers(tx, { recipients: revoked.map((row) => row.userId), actorId: req.user.id,
            eventKey: crypto.randomUUID(), type: 'PERMISSION_REVOKED', title: 'Quyền lô đã được thu hồi do thay đổi cơ sở', batchId: id }) : [];
        return { updatedBatch, revoked, notifications };
    });
    await publishNotifications(notifications);
    await refreshUsers(revoked.map((row) => row.userId), 'permissions');
    await refreshUsers(revoked.map((row) => row.userId), 'tasks');
    await refreshBatch(id);

    res.json({ message: 'Cập nhật lô nuôi trồng thành công', data: updatedBatch });
}));

// 5. DELETE /:id - Xóa lô nuôi trồng
router.delete('/:id', authenticateToken, authorizeRoles(...global.privilegedRoles), handle(async (req, res) => {
    const id = parseId(req.params.id);
    const { deleted, revoked, notifications } = await workflowTransaction(prisma, async (tx) => {
        await requireBatchAccess(tx, req.user, id, true);
        const revoked = await tx.batchStaff.findMany({ where: { batchId: id } });
        const deleted = await tx.cultivationBatch.delete({ where: { id }, include: { images: true, growthRecords: { include: { images: true } }, careLogs: { include: { images: true } } } });
        const notifications = await notifyUsers(tx, { recipients: revoked.map((row) => row.userId), actorId: req.user.id, eventKey: crypto.randomUUID(), type: 'PERMISSION_REVOKED', title: 'Lô nuôi trồng đã được xóa', batchId: id });
        return { deleted, revoked, notifications };
    });
    await publishNotifications(notifications);
    await refreshUsers(revoked.map((row) => row.userId), 'permissions');
    await refreshUsers(revoked.map((row) => row.userId), 'tasks');
    await refreshBatch(id);
    await removeStoredMedia(prisma, [...(deleted.images || []), ...(deleted.growthRecords || []).flatMap((record) => record.images), ...(deleted.careLogs || []).flatMap((record) => record.images)]);
    res.json({ message: 'Xóa lô nuôi trồng thành công' });
}));

router.use(async (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        await removeGrowthProgressUploadFiles(req.files || []);
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? 'Mỗi ảnh đính kèm không được vượt quá 5 MB'
            : 'Chỉ được đính kèm tối đa 5 ảnh cho mỗi lần cập nhật';
        return errorHandler({ status: 400, message }, req, res, next);
    }

    if (error.message === 'Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP') {
        await removeGrowthProgressUploadFiles(req.files || []);
        return errorHandler({ status: 400, message: error.message }, req, res, next);
    }

    next(error);
});

module.exports = router;

