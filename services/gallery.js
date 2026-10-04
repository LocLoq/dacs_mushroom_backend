const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const orderBy = [{ isCover: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }];
const galleryInclude = { images: { take: 1, orderBy }, _count: { select: { images: true } } };
const withGallery = (row) => {
    const { images, _count, ...data } = row;
    return { ...data, coverImageUrl: images?.[0]?.imageUrl || row.imageUrl || null, imageCount: _count?.images || 0 };
};

const removeUploads = async (files = []) => {
    await Promise.all(files.map(async (file) => {
        try { await fs.promises.unlink(file.path); } catch (error) { if (error.code !== 'ENOENT') console.error(error); }
    }));
};

const removeStoredMedia = async (prisma, images = []) => {
    for (const image of images) {
        if (!/^\/uploads\/(?:gallery|growth-progress)\/[\w.-]+$/.test(image.imageUrl)) continue;
        try {
            if (await prisma.taskSubmissionImage.count({ where: { imageUrl: image.imageUrl } })) continue;
            await fs.promises.unlink(path.join(__dirname, '..', image.imageUrl.slice(1)));
        } catch (error) { if (error.code !== 'ENOENT') console.error('Unable to remove media:', error.message); }
    }
};

const createGalleryUpload = () => {
    const directory = path.join(__dirname, '..', 'uploads', 'gallery');
    fs.mkdirSync(directory, { recursive: true });
    const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
    return multer({
        storage: multer.diskStorage({ destination: directory, filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}${extensions[file.mimetype]}`) }),
        limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 1 },
        fileFilter: (req, file, callback) => callback(extensions[file.mimetype] ? null : new Error('Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP'), Boolean(extensions[file.mimetype]))
    }).array('images', 5);
};

module.exports = { galleryInclude, withGallery, removeStoredMedia, createGalleryUpload, removeUploads, orderBy };
