const { fail, id: parseId, pagination, pageResponse, fields, textField, dateField, handle } = require('../services/apiHelpers');
const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { auditAction } = require('../middlewares/audit');

const prisma = global.prisma;
router.use(require('./taskSubmissions'));
const openStatuses = ['TODO', 'IN_PROGRESS'];
const statuses = new Set([...openStatuses, 'PENDING_REVIEW', 'COMPLETED', 'CANCELLED']);
const managerRoles = ['admin', 'manager'];
const optionalId = (value) => value === null ? null : parseId(value);
const optionalDate = (value) => value === null ? null : dateField(value, 'dueAt');
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

router.get('/tasks', authenticateToken, authorizeRoles(...global.allRoles), handle(async (req, res) => {
    const paging = pagination(req.query, 50, 10);
    const { limit, skip } = paging;
    const batchId = req.query.batchId === undefined ? undefined : parseId(req.query.batchId);
    const assigneeUserId = req.query.assigneeUserId === undefined ? undefined : parseId(req.query.assigneeUserId);
    const requestedStatus = req.query.status === undefined ? undefined : req.query.status;
    if (requestedStatus !== undefined && requestedStatus !== 'ALL' && !statuses.has(requestedStatus)) fail(400, 'Bộ lọc công việc không hợp lệ');
    const where = {
        ...(req.query.search ? { title: { contains: textField(req.query.search, 'search', Infinity, true) || '' } } : {}),
        ...(batchId ? { batchId } : {}),
        ...(assigneeUserId ? { assigneeUserId } : {}),
        ...(requestedStatus === undefined ? { status: { in: [...openStatuses, 'PENDING_REVIEW'] } } : requestedStatus === 'ALL' ? {} : { status: requestedStatus })
    };
    const [totalItems, data] = await Promise.all([
        prisma.task.count({ where }),
        prisma.task.findMany({ where, skip, take: limit, include: taskInclude, orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }] })
    ]);
    res.json(pageResponse(data.map(serializeTask), totalItems, paging));
}));

router.get('/tasks/:id', authenticateToken, authorizeRoles(...global.allRoles), handle(async (req, res) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { ...taskInclude, submissions: { orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }] } } });
    if (!task) fail(404, 'Không tìm thấy công việc');
    res.json({ data: serializeTask(task) });
}));

router.get('/task-assignees', authenticateToken, authorizeRoles(...managerRoles), handle(async (req, res) => {
    const paging = pagination(req.query, 50, 10);
    const { limit, skip } = paging;
    const search = req.query.search === undefined ? '' : textField(req.query.search, 'search', Infinity, true);
    const where = search ? { OR: [{ username: { contains: search } }, { full_name: { contains: search } }] } : {};
    const [totalItems, data] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({ where, skip, take: limit, orderBy: { username: 'asc' }, select: { id: true, username: true, full_name: true, role: { select: { name: true } } } })
    ]);
    res.json(pageResponse(data.filter((user) => global.allRoles.includes(user.role?.name)).map((user) => ({ id: user.id, username: user.username, full_name: user.full_name, role: user.role.name })), totalItems, paging));
}));

router.post('/tasks', auditAction('TASK_CREATE', { entityType: 'Task', entityId: (_, res) => res.locals.taskId || null }), authenticateToken, authorizeRoles(...managerRoles), handle(async (req, res) => {
    fields(req.body, ['title', 'description', 'batchId', 'assigneeUserId', 'dueAt']);
    const { title, description, batchId: rawBatchId, assigneeUserId: rawAssigneeUserId, dueAt: rawDueAt } = req.body || {};
    const batchId = rawBatchId === undefined ? null : optionalId(rawBatchId);
    const assigneeUserId = rawAssigneeUserId === undefined ? null : optionalId(rawAssigneeUserId);
    const dueAt = rawDueAt === undefined ? null : optionalDate(rawDueAt);
    const parsedTitle = textField(title, 'title', 255);
    const parsedDescription = description === undefined ? null : textField(description, 'description', Infinity, true);
    const problem = await validateReferences(batchId, assigneeUserId);
    if (problem) fail(400, problem);
    const task = await prisma.task.create({ data: { title: parsedTitle, description: parsedDescription, batchId, assigneeUserId, dueAt, createdByUserId: req.user.id }, include: taskInclude });
    res.locals.taskId = task.id;
    res.status(201).json({ message: 'Tạo công việc thành công', data: serializeTask(task) });
}));

router.patch('/tasks/:id', auditAction('TASK_UPDATE', { entityType: 'Task', entityId: (req) => req.params.id }), authenticateToken, authorizeRoles(...global.allRoles), handle(async (req, res) => {
    const body = req.body || {};
    const permitted = ['title', 'description', 'batchId', 'assigneeUserId', 'dueAt', 'status'];
    fields(body, permitted);
    try {
        const task = await prisma.task.findUnique({ where: { id: req.params.id } });
        if (!task) fail(404, 'Không tìm thấy công việc');
        const manager = managerRoles.includes(req.user.role);
        if (!manager && (Object.keys(body).some((key) => key !== 'status') || task.assigneeUserId !== req.user.id || !openStatuses.includes(task.status) || !openStatuses.includes(body.status))) fail(403, 'Bạn không có quyền cập nhật công việc này', 'AUTH_FORBIDDEN');
        if (['COMPLETED', 'PENDING_REVIEW'].includes(body.status)) fail(400, 'Phải gửi minh chứng và duyệt qua API chuyên dụng');
        if (task.status === 'PENDING_REVIEW' && (Object.keys(body).some((key) => ['batchId', 'assigneeUserId'].includes(key)) || body.status && body.status !== 'CANCELLED')) fail(409, 'Hãy duyệt, trả lại hoặc hủy việc trước khi đổi liên kết/trạng thái', 'STATE_CONFLICT');
        const update = {};
        if ('title' in body) update.title = textField(body.title, 'title', 255);
        if ('description' in body) update.description = textField(body.description, 'description', Infinity, true);
        for (const field of ['batchId', 'assigneeUserId']) if (field in body) update[field] = optionalId(body[field]);
        if ('dueAt' in body) update.dueAt = optionalDate(body.dueAt);
        if ('status' in body) { if (!statuses.has(body.status)) fail(400, 'Trạng thái công việc không hợp lệ'); update.status = body.status; }
        const problem = await validateReferences(update.batchId, update.assigneeUserId);
        if (problem) fail(400, problem);
        const updated = await prisma.$transaction(async (tx) => {
            const result = await tx.task.update({ where: { id: task.id, version: task.version }, data: { ...update, version: { increment: 1 } }, include: taskInclude });
            if (task.status === 'PENDING_REVIEW' && body.status === 'CANCELLED') {
                await tx.taskSubmission.updateMany({ where: { taskId: task.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
                return tx.task.findUnique({ where: { id: task.id }, include: taskInclude });
            }
            return result;
        });
        res.json({ message: 'Cập nhật công việc thành công', data: serializeTask(updated) });
    } catch (error) {
        if (['P2025', 'P2034'].includes(error.code)) fail(409, 'Công việc đã thay đổi; vui lòng tải lại', 'STATE_CONFLICT');
        throw error;
    }
}));

router.delete('/tasks/:id', auditAction('TASK_DELETE', { entityType: 'Task', entityId: (req) => req.params.id }), authenticateToken, authorizeRoles(...managerRoles), handle(async (req, res) => {
    try {
        await prisma.task.delete({ where: { id: req.params.id } });
        res.json({ message: 'Xóa công việc thành công' });
    } catch (error) {
        if (error.code === 'P2003') fail(409, 'Công việc đã có lịch sử minh chứng; hãy hủy thay vì xóa', 'STATE_CONFLICT');
        if (error.code === 'P2025') fail(404, 'Không tìm thấy công việc');
        throw error;
    }
}));

module.exports = router;
