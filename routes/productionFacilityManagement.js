const express = require('express');
const router = express.Router();

const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const prisma = global.prisma;

const allRoles = ['admin', 'manager', 'staff'];
const managerAndAdmin = ['admin', 'manager'];

// 1. GET / - Lấy danh sách cơ sở sản xuất (có phân trang và tìm kiếm)
router.get('/', authenticateToken, authorizeRoles(...allRoles), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const skip = (page - 1) * limit;
        const search = req.query.search || '';

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

        res.json({
            data: facilities,
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

// 2. GET /:id - Lấy chi tiết 1 cơ sở sản xuất
router.get('/:id', authenticateToken, authorizeRoles(...allRoles), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const facility = await prisma.productionFacility.findUnique({
            where: { id },
            include: { mushrooms: true }
        });

        if (!facility) return res.status(404).json({ message: 'Không tìm thấy cơ sở sản xuất' });

        res.json({ data: facility });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

// 3. POST / - Thêm cơ sở sản xuất mới
router.post('/', authenticateToken, authorizeRoles(...managerAndAdmin), async (req, res) => {
    try {
        const { mushrooms, ...facilityData } = req.body;
        
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
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Dữ liệu không hợp lệ hoặc mã số thuế bị trùng', error: error.message });
    }
});

// 4. PUT /:id - Cập nhật thông tin cơ sở
router.put('/:id', authenticateToken, authorizeRoles(...managerAndAdmin), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { mushrooms, ...facilityData } = req.body;

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
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Không tìm thấy ID này hoặc dữ liệu lỗi', error: error.message });
    }
});

// 5. DELETE /:id - Xóa cơ sở sản xuất
router.delete('/:id', authenticateToken, authorizeRoles(...managerAndAdmin), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await prisma.productionFacility.delete({
            where: { id }
        });
        res.json({ message: 'Xóa cơ sở sản xuất thành công' });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Không tìm thấy cơ sở sản xuất để xóa' });
    }
});

module.exports = router;

