const express = require('express');
const jwt = require('jsonwebtoken');

const router = express.Router();

const prisma = global.prisma;

// Middleware xác thực JWT
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"
    
    if (!token) return res.status(401).json({ message: 'Không tìm thấy token' });
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Token không hợp lệ hoặc đã hết hạn' });
        req.user = user;
        next();
    });
};

// Middleware kiểm tra quyền
const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Bạn không có quyền thực hiện hành động này' });
        }
        next();
    };
};

const allRoles = ['admin', 'manager', 'staff'];
const managerAndAdmin = ['admin', 'manager'];

// 1. API Tìm kiếm và Lấy danh sách (Cho phép admin, manager, staff)
// Hỗ trợ phân trang (tối đa 50 item/page) và query search
router.get('/', authenticateToken, authorizeRoles(...allRoles), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Bắt buộc tối đa 50 item
        const skip = (page - 1) * limit;
        const search = req.query.search || '';

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
            where: whereClause,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' }
        });

        res.json({
            data: mushrooms,
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

// 2. API Thêm giống nấm mới (Chỉ cho phép admin, manager)
router.post('/', authenticateToken, authorizeRoles(...managerAndAdmin), async (req, res) => {
    try {
        const newMushroom = await prisma.mushroom.create({
            data: req.body
        });
        res.status(201).json({ message: 'Thêm giống nấm thành công', data: newMushroom });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Dữ liệu không hợp lệ hoặc tên khoa học đã bị trùng', error: error.message });
    }
});

// 3. API Sửa thông tin giống nấm (Chỉ cho phép admin, manager)
router.put('/:id', authenticateToken, authorizeRoles(...managerAndAdmin), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const updatedMushroom = await prisma.mushroom.update({
            where: { id },
            data: req.body
        });
        res.json({ message: 'Cập nhật thành công', data: updatedMushroom });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Không tìm thấy ID nấm này hoặc dữ liệu lỗi', error: error.message });
    }
});

// 4. API Xóa giống nấm (Chỉ cho phép admin, manager)
router.delete('/:id', authenticateToken, authorizeRoles(...managerAndAdmin), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await prisma.mushroom.delete({
            where: { id }
        });
        res.json({ message: 'Xóa giống nấm thành công' });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Không tìm thấy giống nấm để xóa' });
    }
});

module.exports = router;

