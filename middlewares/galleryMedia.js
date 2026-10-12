const path = require('path');
const { optionalAuthenticateToken } = require('./auth');
const { handle } = require('../services/apiHelpers');

const uploadsDirectory = path.resolve(__dirname, '..', 'uploads');

// Resolve URL aliases before checking visibility, including encoded paths and Windows casing.
const galleryMediaAccess = (req, res, next) => {
    let relativePath;
    try {
        const pathname = decodeURIComponent(req.path);
        relativePath = path.relative(uploadsDirectory, path.resolve(uploadsDirectory, `.${pathname}`));
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || pathname.includes('\0')) return res.sendStatus(404);
    } catch {
        return res.sendStatus(404);
    }
    const directoryName = relativePath.split(path.sep)[0].replace(/[ .]+$/, '').toLowerCase();
    if (directoryName !== 'gallery') return next();

    res.set('Cache-Control', 'private, no-store');
    res.vary('Authorization');
    return optionalAuthenticateToken(req, res, () => handle(async () => {
        const filename = path.basename(relativePath);
        if (relativePath.split(path.sep).length !== 2 || !/^[\w.-]+$/.test(filename)) return res.sendStatus(404);
        const where = { imageUrl: `/uploads/gallery/${filename}`, ...(!req.user ? { isPublic: true } : {}) };
        const matches = await Promise.all(['facilityImage', 'mushroomImage', 'batchImage'].map((model) => global.prisma[model].findFirst({ where, select: { id: true } })));
        if (!matches.some(Boolean)) return res.sendStatus(404);
        next();
    })(req, res, next));
};

module.exports = { galleryMediaAccess };
