const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const router = express.Router();
const prisma = global.prisma;

const { authenticateToken, authorizeRoles } = require('../middlewares/auth');

// Quản trị tài khoản chỉ dành cho admin
const onlyAdmin = ['admin'];

// 1. Lấy danh sách Users (kèm phân trang & tìm kiếm)
router.get('/users', authenticateToken, authorizeRoles(...onlyAdmin), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const skip = (page - 1) * limit;
        const search = req.query.search || '';

        const whereClause = search ? {
            OR: [
                { username: { contains: search } },
                { full_name: { contains: search } }
            ]
        } : {};

        const totalItems = await prisma.user.count({ where: whereClause });
        const users = await prisma.user.findMany({
            where: whereClause,
            skip,
            take: limit,
            select: {
                id: true,
                username: true,
                full_name: true,
                role_id: true,
                tokenver: true,
                role: {
                    select: {
                        name: true
                    }
                }
            },
            orderBy: { id: 'desc' }
        });

        res.json({
            data: users,
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

// 2. Lấy danh sách Roles (hữu ích khi admin muốn biết có những role nào để gán cho user)
router.get('/roles', authenticateToken, authorizeRoles(...onlyAdmin), async (req, res) => {
    try {
        const roles = await prisma.role.findMany();
        res.json({ data: roles });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

// 3. Tạo User mới
router.post('/users', authenticateToken, authorizeRoles(...onlyAdmin), async (req, res) => {
    try {
        const { username, password, full_name, role_id } = req.body;

        if (!username || !password || !full_name || !role_id) {
            return res.status(400).json({ message: 'Vui lòng điền đủ thông tin (username, password, full_name, role_id)' });
        }

        const existingUser = await prisma.user.findUnique({ where: { username } });
        if (existingUser) {
            return res.status(400).json({ message: 'Tên đăng nhập (username) đã tồn tại' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        const newUser = await prisma.user.create({
            data: {
                username,
                password_hash,
                full_name,
                role_id: parseInt(role_id),
                tokenver: 1
            },
            select: { id: true, username: true, full_name: true, role_id: true }
        });

        res.status(201).json({ message: 'Tạo tài khoản thành công', data: newUser });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ', error: error.message });
    }
});

// 4. Cập nhật User
router.put('/users/:id', authenticateToken, authorizeRoles(...onlyAdmin), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { password, full_name, role_id } = req.body;
        
        let updateData = {};
        if (full_name) updateData.full_name = full_name;
        if (role_id) updateData.role_id = parseInt(role_id);
        
        if (password) {
            updateData.password_hash = await bcrypt.hash(password, 10);
            // Có thể tự động tăng tokenver nếu muốn user bị bắt đăng nhập lại khi đổi mật khẩu
            updateData.tokenver = { increment: 1 };
        }

        const updatedUser = await prisma.user.update({
            where: { id },
            data: updateData,
            select: { id: true, username: true, full_name: true, role_id: true }
        });

        res.json({ message: 'Cập nhật tài khoản thành công', data: updatedUser });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Không tìm thấy tài khoản hoặc dữ liệu lỗi', error: error.message });
    }
});

// 5. Xóa User
router.delete('/users/:id', authenticateToken, authorizeRoles(...onlyAdmin), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await prisma.user.delete({
            where: { id }
        });
        res.json({ message: 'Xóa tài khoản thành công' });
    } catch (error) {
        console.error(error);
        res.status(400).json({ message: 'Không tìm thấy tài khoản để xóa' });
    }
});

module.exports = router;

