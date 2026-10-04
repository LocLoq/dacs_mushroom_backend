const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { auditAction } = require('../middlewares/audit');

const prisma = global.prisma;
router.use(require('./taskSubmissions'));
const openStatuses = ['TODO', 'IN_PROGRESS'];
const statuses = new Set([...openStatuses, 'PENDING_REVIEW', 'COMPLETED', 'CANCELLED']);
const managerRoles = ['admin', 'manager'];
const positiveInteger = (value) => {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null; }
    return null;
};
const optionalId = (value) => value === null ? null : positiveInteger(value);
const optionalDate = (value) => {
    if (value === null) return null;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
};
const taskInclude = {
    submissions: { orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true, status: true, submittedByUserId: true, reviewedByUserId: true, submittedAt: true, reviewedAt: true, reason: true } },
    batch: { select: { batchCode: true } },
    assignee: { select: { id: true, username: true, full_name: true, role: { select: { name: true } } } }
};
const serializeTask = (task) => ({
    ...task,
    batchCode: task.batch?.batchCode || null,
    batch: undefined,
    assignee: task.assignee ? { id: task.assignee.id, username: task.assignee.username, full_name: task.assignee.full_name, role: task.assignee.role.name } : null
});
const validateReferences = async (batchId, assigneeUserId) => {
    if (batchId !== null && batchId !== undefined && !await prisma.cultivationBatch.findUnique({ where: { id: batchId }, select: { id: true } })) return 'Lô nuôi trồng không tồn tại';
    if (assigneeUserId !== null && assigneeUserId !== undefined) {
        const user = await prisma.user.findUnique({ where: { id: assigneeUserId }, select: { id: true, role: { select: { name: true } } } });
        if (!user || !global.allRoles.includes(user.role?.name)) return 'Người được giao không tồn tại hoặc không hợp lệ';
    }
    return null;
};

router.get('/tasks', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    const page = positiveInteger(req.query.page) || 1;
    const limit = Math.min(positiveInteger(req.query.limit) || 10, 50);
    const batchId = req.query.batchId === undefined ? undefined : positiveInteger(req.query.batchId);
    const assigneeUserId = req.query.assigneeUserId === undefined ? undefined : positiveInteger(req.query.assigneeUserId);
    const requestedStatus = req.query.status === undefined ? undefined : req.query.status;
    if ((req.query.batchId !== undefined && !batchId) || (req.query.assigneeUserId !== undefined && !assigneeUserId) || (requestedStatus !== undefined && requestedStatus !== 'ALL' && !statuses.has(requestedStatus))) return res.status(400).json({ message: 'Bộ lọc công việc không hợp lệ' });
    const where = {
        ...(req.query.search ? { title: { contains: String(req.query.search).trim() } } : {}),
        ...(batchId ? { batchId } : {}),
        ...(assigneeUserId ? { assigneeUserId } : {}),
        ...(requestedStatus === undefined ? { status: { in: [...openStatuses, 'PENDING_REVIEW'] } } : requestedStatus === 'ALL' ? {} : { status: requestedStatus })
    };
    try {
        const [totalItems, data] = await Promise.all([
            prisma.task.count({ where }),
            prisma.task.findMany({ where, skip: (page - 1) * limit, take: limit, include: taskInclude, orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }] })
        ]);
        res.json({ data: data.map(serializeTask), pagination: { totalItems, currentPage: page, totalPages: Math.ceil(totalItems / limit), pageSize: limit } });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Lỗi máy chủ' }); }
});

router.get('/tasks/:id', authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    try {
        const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { ...taskInclude, submissions: { orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }] } } });
        if (!task) return res.status(404).json({ message: 'Không tìm thấy công việc' });
        res.json({ data: serializeTask(task) });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Lỗi máy chủ' }); }
});

router.get('/task-assignees', authenticateToken, authorizeRoles(...managerRoles), async (req, res) => {
    const page = positiveInteger(req.query.page) || 1;
    const limit = Math.min(positiveInteger(req.query.limit) || 10, 50);
    const search = String(req.query.search || '').trim();
    const where = search ? { OR: [{ username: { contains: search } }, { full_name: { contains: search } }] } : {};
    try {
        const [totalItems, data] = await Promise.all([
            prisma.user.count({ where }),
            prisma.user.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { username: 'asc' }, select: { id: true, username: true, full_name: true, role: { select: { name: true } } } })
        ]);
        res.json({ data: data.filter((user) => global.allRoles.includes(user.role?.name)).map((user) => ({ id: user.id, username: user.username, full_name: user.full_name, role: user.role.name })), pagination: { totalItems, currentPage: page, totalPages: Math.ceil(totalItems / limit), pageSize: limit } });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Lỗi máy chủ' }); }
});

router.post('/tasks', auditAction('TASK_CREATE', { entityType: 'Task', entityId: (_, res) => res.locals.taskId || null }), authenticateToken, authorizeRoles(...managerRoles), async (req, res) => {
    const { title, description, batchId: rawBatchId, assigneeUserId: rawAssigneeUserId, dueAt: rawDueAt } = req.body || {};
    const batchId = rawBatchId === undefined ? null : optionalId(rawBatchId);
    const assigneeUserId = rawAssigneeUserId === undefined ? null : optionalId(rawAssigneeUserId);
    const dueAt = rawDueAt === undefined ? null : optionalDate(rawDueAt);
    if (
        typeof title !== 'string' || !title.trim() || title.trim().length > 255
        || (description !== undefined && description !== null && typeof description !== 'string')
        || (rawBatchId !== undefined && rawBatchId !== null && batchId === null)
        || (rawAssigneeUserId !== undefined && rawAssigneeUserId !== null && assigneeUserId === null)
        || dueAt === undefined
    ) return res.status(400).json({ message: 'Dữ liệu công việc không hợp lệ' });
    try {
        const problem = await validateReferences(batchId, assigneeUserId);
        if (problem) return res.status(400).json({ message: problem });
        const task = await prisma.task.create({ data: { title: title.trim(), description: description?.trim() || null, batchId, assigneeUserId, dueAt, createdByUserId: req.user.id }, include: taskInclude });
        res.locals.taskId = task.id;
        res.status(201).json({ message: 'Tạo công việc thành công', data: serializeTask(task) });
    } catch (error) { console.error(error); res.status(400).json({ message: 'Dữ liệu công việc không hợp lệ' }); }
});

router.patch('/tasks/:id', auditAction('TASK_UPDATE', { entityType: 'Task', entityId: (req) => req.params.id }), authenticateToken, authorizeRoles(...global.allRoles), async (req, res) => {
    const body = req.body || {};
    const permitted = ['title', 'description', 'batchId', 'assigneeUserId', 'dueAt', 'status'];
    if (!Object.keys(body).length || Object.keys(body).some((key) => !permitted.includes(key))) return res.status(400).json({ message: 'Dữ liệu công việc không hợp lệ' });
    try {
        const task = await prisma.task.findUnique({ where: { id: req.params.id } });
        if (!task) return res.status(404).json({ message: 'Không tìm thấy công việc' });
        const manager = managerRoles.includes(req.user.role);
        if (!manager && (Object.keys(body).some((key) => key !== 'status') || task.assigneeUserId !== req.user.id || !openStatuses.includes(task.status) || !openStatuses.includes(body.status))) return res.status(403).json({ code: 'AUTH_FORBIDDEN', message: 'Bạn không có quyền cập nhật công việc này' });
        if (['COMPLETED', 'PENDING_REVIEW'].includes(body.status)) return res.status(400).json({ message: 'Phải gửi minh chứng và duyệt qua API chuyên dụng' });
        if (task.status === 'PENDING_REVIEW' && (Object.keys(body).some((key) => ['batchId', 'assigneeUserId'].includes(key)) || body.status && body.status !== 'CANCELLED')) return res.status(409).json({ code: 'STATE_CONFLICT', message: 'Hãy duyệt, trả lại hoặc hủy việc trước khi đổi liên kết/trạng thái' });
        const update = {};
        if ('title' in body) { if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 255) return res.status(400).json({ message: 'Tiêu đề không hợp lệ' }); update.title = body.title.trim(); }
        if ('description' in body) { if (body.description !== null && typeof body.description !== 'string') return res.status(400).json({ message: 'Mô tả không hợp lệ' }); update.description = body.description?.trim() || null; }
        for (const [field, raw] of [['batchId', body.batchId], ['assigneeUserId', body.assigneeUserId]]) if (field in body) { const value = optionalId(raw); if (value === null && raw !== null) return res.status(400).json({ message: 'Liên kết công việc không hợp lệ' }); update[field] = value; }
        if ('dueAt' in body) { const dueAt = optionalDate(body.dueAt); if (dueAt === undefined) return res.status(400).json({ message: 'Hạn công việc không hợp lệ' }); update.dueAt = dueAt; }
        if ('status' in body) { if (!statuses.has(body.status)) return res.status(400).json({ message: 'Trạng thái công việc không hợp lệ' }); update.status = body.status; }
        const problem = await validateReferences(update.batchId, update.assigneeUserId);
        if (problem) return res.status(400).json({ message: problem });
        const updated = await prisma.$transaction(async (tx) => {
            const result = await tx.task.update({ where: { id: task.id, version: task.version }, data: { ...update, version: { increment: 1 } }, include: taskInclude });
            if (task.status === 'PENDING_REVIEW' && body.status === 'CANCELLED') {
                await tx.taskSubmission.updateMany({ where: { taskId: task.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
                return tx.task.findUnique({ where: { id: task.id }, include: taskInclude });
            }
            return result;
        });
        res.json({ message: 'Cập nhật công việc thành công', data: serializeTask(updated) });
    } catch (error) { if (['P2025', 'P2034'].includes(error.code)) return res.status(409).json({ code: 'STATE_CONFLICT', message: 'Công việc đã thay đổi; vui lòng tải lại' }); console.error(error); res.status(500).json({ message: 'Lỗi máy chủ' }); }
});

router.delete('/tasks/:id', auditAction('TASK_DELETE', { entityType: 'Task', entityId: (req) => req.params.id }), authenticateToken, authorizeRoles(...managerRoles), async (req, res) => {
    try {
        await prisma.task.delete({ where: { id: req.params.id } });
        res.json({ message: 'Xóa công việc thành công' });
    } catch (error) { if (error.code === 'P2003') return res.status(409).json({ code: 'STATE_CONFLICT', message: 'Công việc đã có lịch sử minh chứng; hãy hủy thay vì xóa' }); res.status(error.code === 'P2025' ? 404 : 500).json({ message: error.code === 'P2025' ? 'Không tìm thấy công việc' : 'Lỗi máy chủ' }); }
});

module.exports = router;
