const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();

const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const prisma = global.prisma;
const { createGalleryRouter } = require('./gallery');
const { galleryInclude, withGallery, removeStoredMedia } = require('../services/gallery');
router.use(require('./batchFinancials'));
router.use(createGalleryRouter('cultivationBatch', 'batchImage', 'batchId'));

const validDate = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
const finiteNumber = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() && /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
    return null;
};
const validateBatchData = (data) => {
    const allowed = ['batchCode', 'facilityId', 'mushroomId', 'status', 'substrateType', 'spawnSource', 'bagQuantity', 'startDate', 'expectedHarvestDate', 'endDate', 'actualYieldKg', 'defectRate', 'notes'];
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some((field) => !allowed.includes(field))) return 'Chỉ được cập nhật thông tin lô, không được cập nhật quan hệ hoặc metadata';
    for (const field of ['startDate', 'expectedHarvestDate', 'endDate']) if (data[field] !== undefined && data[field] !== null) {
        const parsed = validDate(data[field]);
        if (!parsed) return `${field} không hợp lệ`;
        data[field] = parsed;
    }
    if (data.bagQuantity !== undefined && data.bagQuantity !== null) {
        const value = finiteNumber(data.bagQuantity);
        if (value === null || !Number.isInteger(value) || value < 0) return 'bagQuantity phải là số nguyên không âm';
        data.bagQuantity = value;
    }
    if (data.defectRate !== undefined && data.defectRate !== null) {
        const value = finiteNumber(data.defectRate);
        if (value === null || value < 0 || value > 100) return 'defectRate phải nằm trong khoảng 0 đến 100';
        data.defectRate = value;
    }
    return null;
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

const discardGrowthProgressFilesAndRespond = async (res, files, status, message) => {
    await removeGrowthProgressUploadFiles(files);
    return res.status(status).json({ message });
};

// 1. GET / - Lấy danh sách lô nuôi trồng (có phân trang và bộ lọc)
router.get('/', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const skip = (page - 1) * limit;
        const search = req.query.search || '';
        const facilityId = req.query.facilityId ? parseInt(req.query.facilityId) : undefined;
        const mushroomId = req.query.mushroomId ? parseInt(req.query.mushroomId) : undefined;
        const status = req.query.status;

        const whereClause = {
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

        res.json({
            data: batches.map(withGallery),
            pagination: {
                totalItems,
                currentPage: page,
                totalPages: Math.ceil(totalItems / limit),
                pageSize: limit
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

// 2. GET /:id - Lấy chi tiết 1 lô nuôi trồng
router.get('/:id', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const batch = await prisma.cultivationBatch.findUnique({
            where: { id },
            include: {
                ...galleryInclude,
                facility: true,
                mushroom: true
            }
        });

        if (!batch) return res.status(404).json({ message: 'Không tìm thấy lô nuôi trồng' });

        res.json({ data: withGallery(batch) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

// 3. POST / - Thêm lô nuôi trồng mới
router.post('/', authenticateToken, authorizeRoles(...global.privilegedRoles), async (req, res) => {
    try {
        const batchData = req.body;
        const validationError = validateBatchData(batchData);
        if (validationError) return res.status(400).json({ message: validationError });

        const newBatch = await prisma.cultivationBatch.create({
            data: batchData,
            include: { facility: true, mushroom: true }
        });
        
        res.status(201).json({ message: 'Thêm lô nuôi trồng thành công', data: newBatch });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Dữ liệu không hợp lệ hoặc mã lô bị trùng', error: error.message });
    }
});

// 3a. GET /:id/care-logs - Nhật ký chấm sóc
router.get('/:id/care-logs', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    try {
        const batchId = parseInt(req.params.id);
        const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });

        if (!batch) return res.status(404).json({ message: 'Không tìm thấy lô nuôi trồng' });

        const careLogs = await prisma.cultivationCareLog.findMany({
            where: { batchId },
            orderBy: { recordedAt: 'desc' }
        });

        res.json({ data: careLogs });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

router.post('/:id/care-logs', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    try {
        const batchId = parseInt(req.params.id);
        const { actionType, notes, recordedAt } = req.body;

        if (typeof actionType !== 'string' || !actionType.trim() || typeof notes !== 'string' || !notes.trim()) {
            return res.status(400).json({ message: 'Thiếu thông tin actionType hoặc notes' });
        }
        const parsedRecordedAt = recordedAt === undefined ? new Date() : validDate(recordedAt);
        if (!parsedRecordedAt) return res.status(400).json({ message: 'Thời điểm ghi nhận không hợp lệ' });

        const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });
        if (!batch) return res.status(404).json({ message: 'Không tìm thấy lô nuôi trồng' });

        const careLog = await prisma.cultivationCareLog.create({
            data: {
                batchId,
                actionType: actionType.trim(),
                notes: notes.trim(),
                createdByUserId: req.user.id,
                updatedByUserId: req.user.id,
                recordedAt: parsedRecordedAt
            }
        });

        res.status(201).json({ message: 'Ghi nhật ký chấm sóc thành công', data: careLog });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Dữ liệu không hợp lệ', error: error.message });
    }
});

const parseGrowthProgressId = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const parseGrowthProgressDate = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

// 3b. GET /:id/growth-progress - Theo dõi quá trình sinh trưởng
router.get('/:id/growth-progress', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    try {
        const batchId = parseGrowthProgressId(req.params.id);
        if (!batchId) {
            return res.status(400).json({ message: 'ID lô nuôi trồng không hợp lệ' });
        }

        const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });

        if (!batch) return res.status(404).json({ message: 'Không tìm thấy lô nuôi trồng' });

        const growthRecords = await prisma.growthProgressRecord.findMany({
            where: { batchId },
            include: { images: true },
            orderBy: [
                { recordedAt: 'desc' },
                { id: 'desc' }
            ]
        });

        res.json({ data: growthRecords });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

router.post('/:id/growth-progress', authenticateToken, authorizeRoles(...global.allRoles), growthProgressUpload.array('images', 5), async (req, res) => {
    try {
        const uploadedFiles = req.files || [];
        const batchId = parseGrowthProgressId(req.params.id);
        if (!batchId) {
            return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'ID lô nuôi trồng không hợp lệ');
        }

        const { stage, notes, recordedAt } = req.body || {};

        if (typeof stage !== 'string' || !stage.trim()) {
            return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'Giai đoạn sinh trưởng phải là chuỗi không được để trống');
        }

        if (typeof notes !== 'string' || !notes.trim()) {
            return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'Ghi chú phải là chuỗi không được để trống');
        }

        const parsedRecordedAt = recordedAt === undefined
            ? new Date()
            : parseGrowthProgressDate(recordedAt);

        if (!parsedRecordedAt) {
            return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'Thời điểm ghi nhận không hợp lệ');
        }

        const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });
        if (!batch) return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 404, 'Không tìm thấy lô nuôi trồng');

        const record = await prisma.growthProgressRecord.create({
            data: {
                batchId,
                stage: stage.trim(),
                notes: notes.trim(),
                createdByUserId: req.user.id,
                updatedByUserId: req.user.id,
                recordedAt: parsedRecordedAt,
                ...(uploadedFiles.length > 0 && {
                    images: { create: toGrowthProgressImageData(uploadedFiles) }
                })
            },
            include: { images: true }
        });

        res.status(201).json({ message: 'Cập nhật quá trình sinh trưởng thành công', data: record });
    } catch (error) {
        console.error(error);
        await removeGrowthProgressUploadFiles(req.files || []);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

router.patch('/:id/growth-progress/:recordId', authenticateToken, authorizeRoles(...global.allRoles), growthProgressUpload.array('images', 5), async (req, res) => {
    try {
        const uploadedFiles = req.files || [];
        const batchId = parseGrowthProgressId(req.params.id);
        if (!batchId) {
            return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'ID lô nuôi trồng không hợp lệ');
        }

        const recordId = parseGrowthProgressId(req.params.recordId);
        if (!recordId) {
            return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'ID bản ghi quá trình sinh trưởng không hợp lệ');
        }

        const requestData = req.body || {};
        const allowedFields = ['stage', 'notes', 'recordedAt'];
        const providedFields = Object.keys(requestData);

        if (providedFields.length === 0 && uploadedFiles.length === 0) {
            return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'Cần cung cấp ít nhất một trường hoặc hình ảnh để cập nhật');
        }

        if (providedFields.some((field) => !allowedFields.includes(field))) {
            return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'Chỉ được phép cập nhật stage, notes, recordedAt hoặc hình ảnh');
        }

        const updateData = { updatedByUserId: req.user.id };

        if (Object.prototype.hasOwnProperty.call(requestData, 'stage')) {
            if (typeof requestData.stage !== 'string' || !requestData.stage.trim()) {
                return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'Giai đoạn sinh trưởng phải là chuỗi không được để trống');
            }
            updateData.stage = requestData.stage.trim();
        }

        if (Object.prototype.hasOwnProperty.call(requestData, 'notes')) {
            if (typeof requestData.notes !== 'string' || !requestData.notes.trim()) {
                return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'Ghi chú phải là chuỗi không được để trống');
            }
            updateData.notes = requestData.notes.trim();
        }

        if (Object.prototype.hasOwnProperty.call(requestData, 'recordedAt')) {
            const parsedRecordedAt = parseGrowthProgressDate(requestData.recordedAt);
            if (!parsedRecordedAt) {
                return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 400, 'Thời điểm ghi nhận không hợp lệ');
            }
            updateData.recordedAt = parsedRecordedAt;
        }

        const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });
        if (!batch) return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 404, 'Không tìm thấy lô nuôi trồng');

        const existingRecord = await prisma.growthProgressRecord.findFirst({
            where: { id: recordId, batchId }
        });

        if (!existingRecord) {
            return discardGrowthProgressFilesAndRespond(res, uploadedFiles, 404, 'Không tìm thấy bản ghi quá trình sinh trưởng');
        }

        if (uploadedFiles.length > 0) {
            updateData.images = { create: toGrowthProgressImageData(uploadedFiles) };
        }

        const updatedRecord = await prisma.growthProgressRecord.update({
            where: { id: recordId },
            data: updateData,
            include: { images: true }
        });

        res.json({ message: 'Cập nhật quá trình sinh trưởng thành công', data: updatedRecord });
    } catch (error) {
        console.error(error);
        await removeGrowthProgressUploadFiles(req.files || []);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

// 3c. GET /:id/harvests - Nhật ký thu hoạch
router.get('/:id/harvests', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    try {
        const batchId = parseInt(req.params.id);
        const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });

        if (!batch) return res.status(404).json({ message: 'Không tìm thấy lô nuôi trồng' });

        const harvests = await prisma.harvestRecord.findMany({
            where: { batchId },
            orderBy: { harvestedAt: 'desc' }
        });

        res.json({ data: harvests });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

router.post('/:id/harvests', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    try {
        const batchId = parseInt(req.params.id);
        const { totalYieldKg, qualityGrade, notes, harvestedAt, finalizeBatch } = req.body;

        const parsedYield = finiteNumber(totalYieldKg);
        if (parsedYield === null || parsedYield < 0) {
            return res.status(400).json({ message: 'Thiếu thông tin totalYieldKg' });
        }
        if (finalizeBatch !== undefined && typeof finalizeBatch !== 'boolean') return res.status(400).json({ message: 'finalizeBatch phải là boolean' });
        const parsedHarvestedAt = harvestedAt === undefined ? new Date() : validDate(harvestedAt);
        if (!parsedHarvestedAt) return res.status(400).json({ message: 'Thời điểm thu hoạch không hợp lệ' });

        const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId } });
        if (!batch) return res.status(404).json({ message: 'Không tìm thấy lô nuôi trồng' });

        const harvest = await prisma.$transaction(async (tx) => {
            const locked = await tx.cultivationBatch.updateMany({ where: { id: batchId }, data: { updatedAt: new Date() } });
            if (!locked.count) return null;
            const created = await tx.harvestRecord.create({
                data: {
                    batchId,
                    totalYieldKg: parsedYield,
                    createdByUserId: req.user.id,
                    updatedByUserId: req.user.id,
                    qualityGrade: qualityGrade || null,
                    notes: notes || null,
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

        if (!harvest) return res.status(404).json({ message: 'Không tìm thấy lô nuôi trồng' });

        res.status(201).json({ message: 'Ghi nhận kết quả thu hoạch thành công', data: harvest });
    } catch (error) {
        console.error(error);
        res.status(error.code === 'P2034' ? 409 : 400).json({ message: error.code === 'P2034' ? 'Dữ liệu đã thay đổi; vui lòng thử lại' : 'Dữ liệu không hợp lệ' });
    }
});

// 4. PUT /:id - Cập nhật thông tin lô nuôi trồng
router.put('/:id', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const batchData = req.body;
        const validationError = validateBatchData(batchData);
        if (validationError) return res.status(400).json({ message: validationError });

        const updatedBatch = await prisma.cultivationBatch.update({
            where: { id },
            data: batchData,
            include: { facility: true, mushroom: true }
        });

        res.json({ message: 'Cập nhật lô nuôi trồng thành công', data: updatedBatch });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Không tìm thấy ID hoặc dữ liệu lỗi', error: error.message });
    }
});

// 5. DELETE /:id - Xóa lô nuôi trồng
router.delete('/:id', authenticateToken, authorizeRoles(...global.privilegedRoles), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const deleted = await prisma.cultivationBatch.delete({
            where: { id },
            include: { images: true, growthRecords: { include: { images: true } } }
        });
        await removeStoredMedia(prisma, [...(deleted.images || []), ...(deleted.growthRecords || []).flatMap((record) => record.images)]);
        res.json({ message: 'Xóa lô nuôi trồng thành công' });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Không tìm thấy lô nuôi trồng để xóa' });
    }
});

router.use(async (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        await removeGrowthProgressUploadFiles(req.files || []);
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? 'Mỗi ảnh đính kèm không được vượt quá 5 MB'
            : 'Chỉ được đính kèm tối đa 5 ảnh cho mỗi lần cập nhật';
        return res.status(400).json({ message });
    }

    if (error.message === 'Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP') {
        await removeGrowthProgressUploadFiles(req.files || []);
        return res.status(400).json({ message: error.message });
    }

    next(error);
});

module.exports = router;

