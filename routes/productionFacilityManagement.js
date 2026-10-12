const { fail, id: parseId, pagination, pageResponse, fields, textField, numberField, handle } = require('../services/apiHelpers');
const express = require('express');
const router = express.Router();

const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const prisma = global.prisma;
const { createGalleryRouter } = require('./gallery');
const { galleryInclude, withGallery, removeStoredMedia } = require('../services/gallery');
router.use(createGalleryRouter('productionFacility', 'facilityImage', 'facilityId'));
const allowedFields = ['name', 'taxCode', 'address', 'province', 'contactPhone', 'contactEmail', 'facilityType', 'capacityTonsPerYear', 'totalAreaSqm', 'certifications', 'status', 'mushrooms'];
const facilityDataFrom = (body) => {
    fields(body, allowedFields);
    const { mushrooms, ...data } = body;
    if (mushrooms !== undefined && !Array.isArray(mushrooms)) fail(400, 'mushrooms phải là mảng ID');
    const mushroomIds = mushrooms?.map(parseId);
    for (const field of Object.keys(data)) {
        if (field === 'facilityType' || field === 'status') {
            const values = field === 'facilityType' ? ['HOUSEHOLD', 'COOPERATIVE', 'ENTERPRISE'] : ['ACTIVE', 'SUSPENDED', 'CLOSED'];
            if (!values.includes(data[field])) fail(400, `${field} không hợp lệ`);
        } else if (['capacityTonsPerYear', 'totalAreaSqm'].includes(field)) {
            data[field] = numberField(data[field], field, { min: 0, nullable: true });
        } else {
            data[field] = textField(data[field], field, Infinity, !['name', 'address'].includes(field));
        }
    }
    return { mushrooms: mushroomIds, facilityData: data };
};

const allRoles = ['admin', 'manager', 'staff'];
const managerAndAdmin = ['admin', 'manager'];

// 1. GET / - Lấy danh sách cơ sở sản xuất (có phân trang và tìm kiếm)
router.get('/', authenticateToken, authorizeRoles(...allRoles), handle(async (req, res) => {
    const paging = pagination(req.query, 50, 10);
    const { limit, skip } = paging;
    const search = req.query.search === undefined ? '' : textField(req.query.search, 'search', Infinity, true);

    const whereClause = search ? {
        OR: [
            { name: { contains: search } },
            { taxCode: { contains: search } },
            { address: { contains: search } },
            { province: { contains: search } }
        ]
    } : {};

    const totalItems = await prisma.productionFacility.count({ where: whereClause });
    const facilities = await prisma.productionFacility.findMany({
        where: whereClause,
        skip,
        take: limit,
        include: {
            ...galleryInclude,
            mushrooms: {
                select: {
                    id: true,
                    scientificName: true,
                    commonName: true
                }
            }
        },
        orderBy: { createdAt: 'desc' }
    });

    res.json(pageResponse(facilities.map(withGallery), totalItems, paging));
}));

// 2. GET /:id - Lấy chi tiết 1 cơ sở sản xuất
router.get('/:id', authenticateToken, authorizeRoles(...allRoles), handle(async (req, res) => {
    const id = parseId(req.params.id);
    const facility = await prisma.productionFacility.findUnique({
        where: { id },
        include: { mushrooms: true, ...galleryInclude }
    });

    if (!facility) fail(404, 'Không tìm thấy cơ sở sản xuất');

    res.json({ data: withGallery(facility) });
}));

// 3. POST / - Thêm cơ sở sản xuất mới
router.post('/', authenticateToken, authorizeRoles(...managerAndAdmin), handle(async (req, res) => {
    const { mushrooms, facilityData } = facilityDataFrom(req.body);

    // Cấu trúc connect cho mushrooms nếu frontend truyền mảng các ID nấm [1, 2, 3]
    let connectMushrooms = {};
    if (Array.isArray(mushrooms) && mushrooms.length > 0) {
        connectMushrooms = {
            connect: mushrooms.map(mId => ({ id: mId }))
        };
    }

    const newFacility = await prisma.productionFacility.create({
        data: {
            ...facilityData,
            mushrooms: connectMushrooms
        },
        include: { mushrooms: true }
    });

    res.status(201).json({ message: 'Thêm cơ sở sản xuất thành công', data: newFacility });
}));

// 4. PUT /:id - Cập nhật thông tin cơ sở
router.put('/:id', authenticateToken, authorizeRoles(...managerAndAdmin), handle(async (req, res) => {
    const id = parseId(req.params.id);
    const { mushrooms, facilityData } = facilityDataFrom(req.body);

    // Xử lý quan hệ N-N: Dùng set để ghi đè lại toàn bộ danh sách nấm liên kết với cơ sở này
    let mushroomUpdate = {};
    if (Array.isArray(mushrooms)) {
        mushroomUpdate = {
            set: mushrooms.map(mId => ({ id: mId }))
        };
    }

    const updatedFacility = await prisma.productionFacility.update({
        where: { id },
        data: {
            ...facilityData,
            ...(Array.isArray(mushrooms) && { mushrooms: mushroomUpdate })
        },
        include: { mushrooms: true }
    });

    res.json({ message: 'Cập nhật thành công', data: updatedFacility });
}));

// 5. DELETE /:id - Xóa cơ sở sản xuất
router.delete('/:id', authenticateToken, authorizeRoles(...managerAndAdmin), handle(async (req, res) => {
    const id = parseId(req.params.id);
    const deleted = await prisma.productionFacility.delete({
        where: { id }, include: { images: true }
    });
    await removeStoredMedia(prisma, deleted.images || []);
    res.json({ message: 'Xóa cơ sở sản xuất thành công' });
}));

module.exports = router;
