const { fail, id: parseId, pagination, pageResponse, fields, textField, dateField, handle } = require('../services/apiHelpers');
const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const prisma = global.prisma;

const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { auditAction } = require('../middlewares/audit');

// Quản trị tài khoản chỉ dành cho admin
const onlyAdmin = ['admin'];
const managerAndAdmin = ['admin', 'manager'];

router.get('/audit-logs', auditAction('AUDIT_LOG_VIEW', { entityType: 'AuditLog' }), authenticateToken, authorizeRoles(...managerAndAdmin), handle(async (req, res) => {
    const paging = pagination(req.query, 100, 20);
    const { limit, skip } = paging;
    const filters = { ...req.query };
    // The default filter form sends empty strings for unselected filters.
    for (const name of ['actorUserId', 'statusCode', 'action', 'entityType', 'entityId', 'outcome', 'from', 'to']) {
        if (typeof filters[name] === 'string' && !filters[name].trim()) delete filters[name];
    }
    const actorUserId = filters.actorUserId === undefined ? undefined : parseId(filters.actorUserId);
    const statusCode = filters.statusCode === undefined ? undefined : parseId(filters.statusCode);
    const from = filters.from === undefined ? undefined : dateField(filters.from, 'from');
    const to = filters.to === undefined ? undefined : dateField(filters.to, 'to');
    if ((filters.outcome !== undefined && !['SUCCESS', 'FAILURE'].includes(filters.outcome)) || (from && to && from > to)) {
        fail(400, 'Bộ lọc audit log không hợp lệ');
    }

    const where = {
        ...(actorUserId && { actorUserId }),
        ...(filters.action && { action: textField(filters.action, 'action', Infinity) }),
        ...(filters.entityType && { entityType: textField(filters.entityType, 'entityType', Infinity) }),
        ...(filters.entityId && { entityId: textField(filters.entityId, 'entityId', Infinity) }),
        ...(filters.outcome && { outcome: filters.outcome }),
        ...(statusCode && { statusCode }),
        ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } })
    };
    const [totalItems, data] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } })
    ]);
    res.json(pageResponse(data, totalItems, paging));
}));

// 1. Lấy danh sách Users (kèm phân trang & tìm kiếm)
router.get('/users', authenticateToken, authorizeRoles(...onlyAdmin), handle(async (req, res) => {
    const paging = pagination(req.query, 50, 10);
    const { limit, skip } = paging;
    const search = req.query.search === undefined ? '' : textField(req.query.search, 'search', Infinity, true);

    const whereClause = { ...(req.query.role ? { role: { name: textField(req.query.role, 'role', 50) } } : {}), ...(search ? {
        OR: [
            { username: { contains: search } },
            { full_name: { contains: search } }
        ]
    } : {}) };

    const totalItems = await prisma.user.count({ where: whereClause });
    const users = await prisma.user.findMany({
        where: whereClause,
        skip,
        take: limit,
        select: {
            id: true,
            username: true,
            full_name: true,
            phone_number: true,
            email: true,
            role_id: true,
            tokenver: true,
            must_change_password: true,
            role: {
                select: {
                    name: true
                }
            }
        },
        orderBy: { id: 'desc' }
    });

    res.json(pageResponse(users, totalItems, paging));
}));

// 2. Lấy danh sách Roles (hữu ích khi admin muốn biết có những role nào để gán cho user)
router.get('/roles', authenticateToken, authorizeRoles(...onlyAdmin), handle(async (req, res) => {
    const roles = await prisma.role.findMany();
    res.json({ data: roles });
}));

// 3. Tạo User mới
router.post('/users', authenticateToken, authorizeRoles(...onlyAdmin), handle(async (req, res) => {
    fields(req.body, ['username', 'password', 'full_name', 'role_id', 'phone_number', 'email', 'must_change_password']);
    const { password, must_change_password = false } = req.body;
    if (typeof must_change_password !== 'boolean') fail(400, 'must_change_password phải là Boolean');
    const username = textField(req.body.username, 'username', 50);
    const full_name = textField(req.body.full_name, 'full_name', Infinity);
    const phone_number = textField(req.body.phone_number, 'phone_number', Infinity);
    const email = textField(req.body.email, 'email', Infinity);
    const role_id = parseId(req.body.role_id);
    if (typeof password !== 'string' || !password.length) fail(400, 'password không hợp lệ');

    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) {
        fail(400, 'Tên đăng nhập (username) đã tồn tại');
    }

    const password_hash = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
        data: {
            username,
            password_hash,
            full_name,
            phone_number,
            email,
            role_id,
            must_change_password,
            tokenver: 1
        },
        select: { id: true, username: true, full_name: true, role_id: true, must_change_password: true }
    });

    res.status(201).json({ message: 'Tạo tài khoản thành công', data: newUser });
}));

// 4. Cập nhật User
router.put('/users/:id', authenticateToken, authorizeRoles(...onlyAdmin), handle(async (req, res) => {
    const id = parseId(req.params.id);
    fields(req.body, ['password', 'full_name', 'role_id', 'phone_number', 'email', 'must_change_password']);
    const { password, full_name, role_id, phone_number, email } = req.body;

    let updateData = {};
    if (req.body.must_change_password !== undefined) {
        if (typeof req.body.must_change_password !== 'boolean') fail(400, 'must_change_password phải là Boolean');
        updateData.must_change_password = req.body.must_change_password;
    }
    if (full_name !== undefined) updateData.full_name = textField(full_name, 'full_name', Infinity);
    if (phone_number !== undefined) updateData.phone_number = textField(phone_number, 'phone_number', Infinity);
    if (email !== undefined) updateData.email = textField(email, 'email', Infinity);
    if (role_id !== undefined) updateData.role_id = parseId(role_id);

    if (password !== undefined) {
        if (typeof password !== 'string' || !password.length) fail(400, 'password không hợp lệ');
        updateData.password_hash = await bcrypt.hash(password, 10);
    }
    if (password !== undefined || role_id !== undefined) updateData.tokenver = { increment: 1 };

    const updatedUser = await prisma.user.update({
        where: { id },
        data: updateData,
        select: { id: true, username: true, full_name: true, phone_number: true, email: true, role_id: true, must_change_password: true }
    });

    res.json({ message: 'Cập nhật tài khoản thành công', data: updatedUser });
}));

// 5. Xóa User
router.delete('/users/:id', authenticateToken, authorizeRoles(...onlyAdmin), handle(async (req, res) => {
    const id = parseId(req.params.id);
    await prisma.user.delete({
        where: { id }
    });
    res.json({ message: 'Xóa tài khoản thành công' });
}));

module.exports = router;
