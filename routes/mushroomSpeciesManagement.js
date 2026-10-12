const { fail, id: parseId, pagination, pageResponse, fields, textField, handle } = require('../services/apiHelpers');
const express = require('express');

const router = express.Router();

const prisma = global.prisma;

const { authenticateToken, optionalAuthenticateToken, authorizeRoles } = require('../middlewares/auth');
const { createGalleryRouter } = require('./gallery');
const { galleryInclude, publicGalleryInclude, withGallery, removeStoredMedia } = require('../services/gallery');
router.use(createGalleryRouter('mushroom', 'mushroomImage', 'mushroomId'));
router.use((req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method)) {
        res.set('Cache-Control', 'private, no-store');
        res.vary('Authorization');
    }
    next();
});
const allowedFields = ['scientificName', 'commonName', 'otherNames', 'family', 'genus', 'capDescription', 'gillsDescription', 'stemDescription', 'sporePrintColor', 'bruisingBehavior', 'ecologyType', 'habitat', 'fruitingSeason', 'edibilityStatus', 'toxicitySymptoms', 'medicinalProperties', 'cultivationDifficulty', 'imageUrl'];
const mushroomData = (body) => {
    fields(body, allowedFields);
    const data = { ...body };
    const enums = {
        ecologyType: ['SAPROBIC', 'MYCORRHIZAL', 'PARASITIC'],
        edibilityStatus: ['CHOICE', 'EDIBLE', 'INEDIBLE', 'POISONOUS', 'DEADLY'],
        cultivationDifficulty: ['EASY', 'MEDIUM', 'HARD', 'UNCULTIVABLE']
    };
    for (const field of Object.keys(data)) {
        if (enums[field]) {
            if (!(data[field] === null && field !== 'edibilityStatus') && !enums[field].includes(data[field])) fail(400, `${field} không hợp lệ`);
        } else {
            data[field] = textField(data[field], field, Infinity, !['scientificName', 'commonName', 'family', 'genus'].includes(field));
        }
    }
    return data;
};

// 1. API tìm kiếm và lấy danh sách công khai
// Hỗ trợ phân trang (tối đa 50 item/page) và query search
router.get('/', optionalAuthenticateToken, handle(async (req, res) => {
    const paging = pagination(req.query, 50, 10);
    const { limit, skip } = paging;
    const search = req.query.search === undefined ? '' : textField(req.query.search, 'search', Infinity, true);

    // Tìm kiếm theo các trường tên, họ, chi (family, genus)
    const whereClause = search ? {
        OR: [
            { scientificName: { contains: search } },
            { commonName: { contains: search } },
            { otherNames: { contains: search } },
            { family: { contains: search } },
            { genus: { contains: search } }
        ]
    } : {};

    const totalItems = await prisma.mushroom.count({ where: whereClause });
    const mushrooms = await prisma.mushroom.findMany({
        include: req.user ? galleryInclude : publicGalleryInclude,
        where: whereClause,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
    });

    res.json(pageResponse(mushrooms.map(withGallery), totalItems, paging));
}));

router.get('/:id', optionalAuthenticateToken, handle(async (req, res) => {
    const mushroom = await prisma.mushroom.findUnique({ where: { id: parseId(req.params.id) }, include: req.user ? galleryInclude : publicGalleryInclude });
    if (!mushroom) fail(404, 'Không tìm thấy giống nấm');
    res.json({ data: withGallery(mushroom) });
}));

// 2. API Thêm giống nấm mới (Chỉ cho phép admin, manager)
router.post('/', authenticateToken, authorizeRoles(...global.privilegedRoles), handle(async (req, res) => {
    const data = mushroomData(req.body);
    const newMushroom = await prisma.mushroom.create({
        data
    });
    res.status(201).json({ message: 'Thêm giống nấm thành công', data: newMushroom });
}));

// 3. API Sửa thông tin giống nấm (Chỉ cho phép admin, manager)
router.put('/:id', authenticateToken, authorizeRoles(...global.privilegedRoles), handle(async (req, res) => {
    const data = mushroomData(req.body);
    const id = parseId(req.params.id);
    const updatedMushroom = await prisma.mushroom.update({
        where: { id },
        data
    });
    res.json({ message: 'Cập nhật thành công', data: updatedMushroom });
}));

// 4. API Xóa giống nấm (Chỉ cho phép admin, manager)
router.delete('/:id', authenticateToken, authorizeRoles(...global.privilegedRoles), handle(async (req, res) => {
    const id = parseId(req.params.id);
    const deleted = await prisma.mushroom.delete({
        where: { id }, include: { images: true }
    });
    await removeStoredMedia(prisma, deleted.images || []);
    res.json({ message: 'Xóa giống nấm thành công' });
}));

module.exports = router;
