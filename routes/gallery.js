const express = require('express');
const multer = require('multer');
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { auditAction } = require('../middlewares/audit');
const { fail, id, pagination, pageResponse, fields, textField, handle } = require('../services/apiHelpers');
const { createGalleryUpload, removeUploads, removeStoredMedia, orderBy } = require('../services/gallery');

const createGalleryRouter = (parentModel, imageModel, parentField) => {
    const router = express.Router();
    const prisma = global.prisma;
    const upload = createGalleryUpload();
    const all = [authenticateToken, authorizeRoles(...global.allRoles)];
    const managers = [authenticateToken, authorizeRoles(...global.privilegedRoles)];
    const audit = (action) => auditAction(`GALLERY_${action}`, { entityType: parentModel, entityId: (req) => req.params.id });
    const lockParent = async (tx, parentId) => {
        const changed = await tx[parentModel].updateMany({ where: { id: parentId }, data: { updatedAt: new Date() } });
        if (!changed.count) fail(404, 'Không tìm thấy đối tượng');
    };

    router.get('/:id/images', ...all, handle(async (req, res) => {
        const parentId = id(req.params.id);
        const paging = pagination(req.query);
        if (!await prisma[parentModel].findUnique({ where: { id: parentId }, select: { id: true } })) fail(404, 'Không tìm thấy đối tượng');
        const where = { [parentField]: parentId };
        const [total, rows] = await Promise.all([prisma[imageModel].count({ where }), prisma[imageModel].findMany({ where, skip: paging.skip, take: paging.limit, orderBy })]);
        res.json(pageResponse(rows, total, paging));
    }));

    router.post('/:id/images', audit('UPLOAD'), ...managers, handle(async (req, res) => {
        const parentId = id(req.params.id);
        if (!await prisma[parentModel].findUnique({ where: { id: parentId }, select: { id: true } })) fail(404, 'Không tìm thấy đối tượng');
        let committed = false;
        try {
            await new Promise((resolve, reject) => upload(req, res, (error) => error ? reject(error) : resolve()));
            if (!req.files?.length) fail(400, 'Cần tải lên ít nhất một ảnh');
            if (Object.keys(req.body || {}).some((key) => key !== 'caption')) fail(400, 'Chỉ hỗ trợ trường caption và images');
            const caption = req.body.caption === undefined ? null : textField(req.body.caption, 'caption', 500, true);
            const rows = await prisma.$transaction(async (tx) => {
                await lockParent(tx, parentId);
                const hasImages = await tx[imageModel].count({ where: { [parentField]: parentId } });
                const created = [];
                for (const [index, file] of req.files.entries()) {
                    if (file.originalname.length > 255) fail(400, 'Tên tệp quá dài');
                    created.push(await tx[imageModel].create({ data: { [parentField]: parentId, imageUrl: `/uploads/gallery/${file.filename}`, originalName: file.originalname, mimeType: file.mimetype, fileSize: file.size, caption, isCover: !hasImages && index === 0, uploadedByUserId: req.user.id } }));
                }
                return created;
            });
            committed = true;
            res.status(201).json({ message: 'Thêm ảnh thành công', data: rows });
        } catch (error) {
            if (!committed) await removeUploads(req.files);
            if (error instanceof multer.MulterError) fail(400, error.code === 'LIMIT_FILE_SIZE' ? 'Mỗi ảnh tối đa 5 MB' : 'Tối đa 5 ảnh và một caption mỗi lần tải');
            if (error.message === 'Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP') fail(400, error.message);
            throw error;
        }
    }));

    router.patch('/:id/images/:imageId', audit('UPDATE'), ...managers, handle(async (req, res) => {
        const parentId = id(req.params.id);
        const imageId = id(req.params.imageId);
        fields(req.body, ['caption', 'isCover']);
        if ('isCover' in req.body && req.body.isCover !== true) fail(400, 'Dùng isCover: true để chọn ảnh bìa');
        const data = { ...('caption' in req.body ? { caption: textField(req.body.caption, 'caption', 500, true) } : {}), ...(req.body.isCover ? { isCover: true } : {}) };
        const row = await prisma.$transaction(async (tx) => {
            await lockParent(tx, parentId);
            if (!await tx[imageModel].findFirst({ where: { id: imageId, [parentField]: parentId } })) fail(404, 'Không tìm thấy ảnh trong gallery');
            if (data.isCover) await tx[imageModel].updateMany({ where: { [parentField]: parentId, isCover: true }, data: { isCover: false } });
            return tx[imageModel].update({ where: { id: imageId }, data });
        });
        res.json({ message: 'Cập nhật ảnh thành công', data: row });
    }));

    router.delete('/:id/images/:imageId', audit('DELETE'), ...managers, handle(async (req, res) => {
        const parentId = id(req.params.id);
        const imageId = id(req.params.imageId);
        const row = await prisma.$transaction(async (tx) => {
            await lockParent(tx, parentId);
            const image = await tx[imageModel].findFirst({ where: { id: imageId, [parentField]: parentId } });
            if (!image) fail(404, 'Không tìm thấy ảnh trong gallery');
            await tx[imageModel].delete({ where: { id: imageId } });
            if (image.isCover) {
                const next = await tx[imageModel].findFirst({ where: { [parentField]: parentId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
                if (next) await tx[imageModel].update({ where: { id: next.id }, data: { isCover: true } });
            }
            return image;
        });
        await removeStoredMedia(prisma, [row]);
        res.json({ message: 'Xóa ảnh thành công' });
    }));
    return router;
};

module.exports = { createGalleryRouter };
