const { workflowTransaction } = require('../services/access');
const { fail, id: parseId, pagination, pageResponse, fields, textField, dateField, handle } = require('../services/apiHelpers');
const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { auditAction } = require('../middlewares/audit');

const prisma = global.prisma;
const { taskScope, requireTaskAccess, requireBatchAccess } = require('../services/access');
const { taskNotifications, publishNotifications } = require('../services/notifications');
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
const validateReferences = async (client, batchId, assigneeUserId, allowRevoked = false) => {
    if (batchId !== null && batchId !== undefined) {
        try { await requireBatchAccess(client, { role: 'admin' }, batchId, true); }
        catch (error) { if (error.status === 404) fail(400, 'Lô nuôi trồng không tồn tại'); throw error; }
    }
    if (assigneeUserId !== null && assigneeUserId !== undefined) {
        const user = await client.user.findUnique({ where: { id: assigneeUserId }, select: { id: true, role: { select: { name: true } } } });
        if (!user || !global.allRoles.includes(user.role?.name)) fail(400, 'Người được giao không tồn tại hoặc không hợp lệ');
        if (batchId != null && user.role.name === 'staff' && !allowRevoked) {
            try { await requireBatchAccess(client, { id: user.id, role: 'staff' }, batchId); }
            catch (error) { if (error.status === 403) fail(400, 'Người nhận chưa được phân công lô hoặc chưa thuộc cơ sở'); throw error; }
        }
    }
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
        ...taskScope(req.user),
        ...(requestedStatus === undefined ? { status: { in: (req.user.role === 'staff' ? openStatuses : [...openStatuses, 'PENDING_REVIEW']) } } : requestedStatus === 'ALL' ? {} : { status: requestedStatus })
    };
    const [totalItems, data] = await Promise.all([
        prisma.task.count({ where }),
        prisma.task.findMany({ where, skip, take: limit, include: taskInclude, orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }] })
    ]);
    res.json(pageResponse(data.map(serializeTask), totalItems, paging));
}));

router.get('/tasks/:id', authenticateToken, authorizeRoles(...global.allRoles), handle(async (req, res) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { ...taskInclude, submissions: { orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }] } } });
    await requireTaskAccess(prisma, req.user, task);
    res.json({ data: serializeTask(task) });
}));

router.get('/task-assignees', authenticateToken, authorizeRoles(...managerRoles), handle(async (req, res) => {
    const paging = pagination(req.query, 50, 10);
    const { limit, skip } = paging;
    const search = req.query.search === undefined ? '' : textField(req.query.search, 'search', Infinity, true);
    const batchId = req.query.batchId === undefined ? null : parseId(req.query.batchId);
    const batch = batchId === null ? null : await requireBatchAccess(prisma, req.user, batchId);
    const where = { AND: [
        { role: { name: { in: global.allRoles } } },
        ...(search ? [{ OR: [{ username: { contains: search } }, { full_name: { contains: search } }] }] : []),
        ...(batch ? [{ OR: [{ role: { name: { in: managerRoles } } }, { role: { name: 'staff' }, facilityMemberships: { some: { facilityId: batch.facilityId } }, batchAssignments: { some: { batchId } } }] }] : [])
    ] };
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
    const { task, notifications } = await workflowTransaction(prisma, async (tx) => {
        await validateReferences(tx, batchId, assigneeUserId);
        const task = await tx.task.create({ data: { title: parsedTitle, description: parsedDescription, batchId, assigneeUserId, dueAt, createdByUserId: req.user.id }, include: taskInclude });
        return { task, notifications: await taskNotifications(tx, task, req.user.id, 'TASK_CREATED') };
    });
    await publishNotifications(notifications, [req.user.id], task.id);
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
        const { updated, notifications } = await workflowTransaction(prisma, async (tx) => {
            await requireTaskAccess(tx, req.user, task, true);
            await validateReferences(tx, Object.hasOwn(update, 'batchId') ? update.batchId : task.batchId, Object.hasOwn(update, 'assigneeUserId') ? update.assigneeUserId : task.assigneeUserId, body.status === 'CANCELLED');
            const result = await tx.task.update({ where: { id: task.id, version: task.version }, data: { ...update, version: { increment: 1 } }, include: taskInclude });
            if (task.status === 'PENDING_REVIEW' && body.status === 'CANCELLED') {
                await tx.taskSubmission.updateMany({ where: { taskId: task.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
                // Submission snapshots remain available to reviewers after cancellation.
            }
            return { updated: result, notifications: await taskNotifications(tx, result, req.user.id, result.status === 'CANCELLED' ? 'TASK_CANCELLED' : 'TASK_UPDATED', [task.assigneeUserId]) };
        });
        await publishNotifications(notifications, [req.user.id], updated.id);
        res.json({ message: 'Cập nhật công việc thành công', data: serializeTask(updated) });
    } catch (error) {
        if (['P2025', 'P2034'].includes(error.code)) fail(409, 'Công việc đã thay đổi; vui lòng tải lại', 'STATE_CONFLICT');
        throw error;
    }
}));

router.delete('/tasks/:id', auditAction('TASK_DELETE', { entityType: 'Task', entityId: (req) => req.params.id }), authenticateToken, authorizeRoles(...managerRoles), handle(async (req, res) => {
    try {
        const { task, notifications } = await workflowTransaction(prisma, async (tx) => {
            const task = await tx.task.findUnique({ where: { id: req.params.id } });
            if (!task) fail(404, 'Không tìm thấy công việc');
            await tx.task.delete({ where: { id: task.id } });
            return { task, notifications: await taskNotifications(tx, task, req.user.id, 'TASK_DELETED') };
        });
        await publishNotifications(notifications, [req.user.id], task.id);
        res.json({ message: 'Xóa công việc thành công' });
    } catch (error) {
        if (error.code === 'P2003') fail(409, 'Công việc đã có lịch sử minh chứng; hãy hủy thay vì xóa', 'STATE_CONFLICT');
        if (error.code === 'P2025') fail(404, 'Không tìm thấy công việc');
        throw error;
    }
}));

module.exports = router;
