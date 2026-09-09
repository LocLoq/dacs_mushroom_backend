const express = require('express');
const router = express.Router();

const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const prisma = global.prisma;

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
            data: batches,
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
                facility: true,
                mushroom: true
            }
        });

        if (!batch) return res.status(404).json({ message: 'Không tìm thấy lô nuôi trồng' });

        res.json({ data: batch });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

// 3. POST / - Thêm lô nuôi trồng mới
router.post('/', authenticateToken, authorizeRoles(...global.privilegedRoles), async (req, res) => {
    try {
        const batchData = req.body;
        
        // Chuyển đổi định dạng ngày sang kiểu Date của JS nếu FE truyền lên string ISO
        if (batchData.startDate) batchData.startDate = new Date(batchData.startDate);
        if (batchData.expectedHarvestDate) batchData.expectedHarvestDate = new Date(batchData.expectedHarvestDate);
        if (batchData.endDate) batchData.endDate = new Date(batchData.endDate);

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

// 4. PUT /:id - Cập nhật thông tin lô nuôi trồng
router.put('/:id', authenticateToken, authorizeRoles(...global.privilegedRoles), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const batchData = req.body;

        if (batchData.startDate) batchData.startDate = new Date(batchData.startDate);
        if (batchData.expectedHarvestDate) batchData.expectedHarvestDate = new Date(batchData.expectedHarvestDate);
        if (batchData.endDate) batchData.endDate = new Date(batchData.endDate);

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
        await prisma.cultivationBatch.delete({
            where: { id }
        });
        res.json({ message: 'Xóa lô nuôi trồng thành công' });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Không tìm thấy lô nuôi trồng để xóa' });
    }
});

module.exports = router;

