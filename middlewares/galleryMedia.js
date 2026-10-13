const path = require('path');
const { optionalAuthenticateToken } = require('./auth');
const { handle } = require('../services/apiHelpers');
const { requireBatchAccess, requireFacilityAccess, taskScope } = require('../services/access');

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
    if (!['gallery', 'care-logs'].includes(directoryName)) return next();

    res.set('Cache-Control', 'private, no-store');
    res.vary('Authorization');
    return optionalAuthenticateToken(req, res, () => handle(async () => {
        const filename = path.basename(relativePath);
        if (relativePath.split(path.sep).length !== 2 || !/^[\w.-]+$/.test(filename)) return res.sendStatus(404);
        const imageUrl = `/uploads/${directoryName}/${filename}`;
        const prisma = global.prisma;
        if (directoryName === 'care-logs') {
            if (!req.user) return res.sendStatus(404);
            const image = await prisma.careLogImage.findFirst({ where: { imageUrl }, include: { careLog: true } });
            if (image) await requireBatchAccess(prisma, req.user, image.careLog.batchId);
            else if (!await prisma.taskSubmissionImage.findFirst({ where: { imageUrl, submission: { task: taskScope(req.user) } } })) return res.sendStatus(404);
            return next();
        }
        const where = { imageUrl, ...(!req.user ? { isPublic: true } : {}) };
        const matches = await Promise.all(['facilityImage', 'mushroomImage', 'batchImage'].map((model) => prisma[model].findFirst({ where })));
        for (let index = 0; index < matches.length; index++) {
            const image = matches[index];
            if (!image) continue;
            if (!req.user || image.isPublic || req.user.role !== 'staff' || index === 1) return next();
            if (index === 0) await requireFacilityAccess(prisma, req.user, image.facilityId);
            else await requireBatchAccess(prisma, req.user, image.batchId);
            return next();
        }
        return res.sendStatus(404);
    })(req, res, next));
};

module.exports = { galleryMediaAccess };
