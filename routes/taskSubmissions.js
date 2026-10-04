const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { auditAction } = require('../middlewares/audit');
const { fail, id, pagination, pageResponse, fields, textField, handle } = require('../services/apiHelpers');

const router = express.Router();
const prisma = global.prisma;
const sources = { CARE_LOG: 'cultivationCareLog', GROWTH_PROGRESS: 'growthProgressRecord', HARVEST: 'harvestRecord' };
const editableStatuses = ['TODO', 'IN_PROGRESS'];

const eligibleWhere = (task, userId) => ({
    ...(task.batchId === null ? {} : { batchId: task.batchId }),
    OR: [{ createdByUserId: userId }, { updatedByUserId: userId }]
});

const ownedTask = async (client, taskId, userId) => {
    const task = await client.task.findUnique({ where: { id: taskId } });
    if (!task) fail(404, 'Không tìm thấy công việc');
    if (task.assigneeUserId !== userId) fail(403, 'Chỉ người được giao việc được gửi minh chứng');
    return task;
};

router.get('/tasks/:id/evidence-candidates', authenticateToken, authorizeRoles(...global.allRoles), handle(async (req, res) => {
    const task = await ownedTask(prisma, req.params.id, req.user.id);
    const paging = pagination(req.query);
    const types = req.query.type === undefined ? Object.keys(sources) : [req.query.type];
    if (types.some((type) => !sources[type])) fail(400, 'Loại minh chứng không hợp lệ');
    const where = eligibleWhere(task, req.user.id);
    const groups = await Promise.all(types.map(async (type) => {
        const model = prisma[sources[type]];
        const [total, rows] = await Promise.all([
            model.count({ where }),
            model.findMany({ where, take: paging.skip + paging.limit, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...(type === 'GROWTH_PROGRESS' ? { include: { images: true } } : {}) })
        ]);
        return { total, rows: rows.map((record) => ({ type, recordId: record.id, record })) };
    }));
    const rows = groups.flatMap((group) => group.rows).sort((left, right) => new Date(right.record.createdAt) - new Date(left.record.createdAt) || right.recordId - left.recordId || left.type.localeCompare(right.type));
    res.json(pageResponse(rows.slice(paging.skip, paging.skip + paging.limit), groups.reduce((sum, group) => sum + group.total, 0), paging));
}));

router.post('/tasks/:id/submissions', auditAction('TASK_SUBMIT', { entityType: 'Task', entityId: (req) => req.params.id }), authenticateToken, authorizeRoles(...global.allRoles), handle(async (req, res) => {
    fields(req.body, ['evidence', 'notes']);
    const { evidence } = req.body;
    const notes = req.body.notes === undefined ? null : textField(req.body.notes, 'notes', 10000, true);
    if (!Array.isArray(evidence) || !evidence.length || evidence.length > 20) fail(400, 'Cần từ 1 đến 20 hành động minh chứng');
    const keys = new Set();
    const references = evidence.map((item) => {
        fields(item, ['type', 'recordId']);
        if (!sources[item.type]) fail(400, 'Loại minh chứng không hợp lệ');
        const recordId = id(item.recordId);
        const key = `${item.type}:${recordId}`;
        if (keys.has(key)) fail(400, 'Minh chứng bị trùng');
        keys.add(key);
        return { type: item.type, recordId };
    });
    const submission = await prisma.$transaction(async (tx) => {
        const task = await ownedTask(tx, req.params.id, req.user.id);
        if (!editableStatuses.includes(task.status)) fail(409, 'Công việc không ở trạng thái cho phép gửi');
        const changed = await tx.task.updateMany({ where: { id: task.id, version: task.version, status: task.status, assigneeUserId: req.user.id }, data: { status: 'PENDING_REVIEW', version: { increment: 1 } } });
        if (changed.count !== 1) fail(409, 'Công việc đã thay đổi');
        const snapshots = [];
        for (const reference of references) {
            const record = await tx[sources[reference.type]].findFirst({ where: { id: reference.recordId, ...eligibleWhere(task, req.user.id) }, ...(reference.type === 'GROWTH_PROGRESS' ? { include: { images: true } } : {}) });
            if (!record) fail(400, 'Minh chứng không tồn tại, sai lô hoặc không do bạn thực hiện');
            const locked = await tx.cultivationBatch.updateMany({ where: { id: record.batchId }, data: { updatedAt: new Date() } });
            if (!locked.count) fail(409, 'Lô minh chứng đã bị xóa');
            snapshots.push({ ...reference, record: JSON.parse(JSON.stringify(record)) });
        }
        const imageUrls = [...new Set(snapshots.flatMap((snapshot) => (snapshot.record.images || []).map((image) => image.imageUrl)))];
        return tx.taskSubmission.create({ data: { taskId: task.id, submittedByUserId: req.user.id, notes, evidence: snapshots, ...(imageUrls.length ? { images: { create: imageUrls.map((imageUrl) => ({ imageUrl })) } } : {}) } });
    });
    res.status(201).json({ message: 'Đã gửi minh chứng, chờ quản lý duyệt', data: submission });
}));

router.post('/tasks/:id/submissions/:submissionId/review', auditAction('TASK_REVIEW', { entityType: 'Task', entityId: (req) => req.params.id }), authenticateToken, authorizeRoles(...global.privilegedRoles), handle(async (req, res) => {
    fields(req.body, ['decision', 'reason']);
    const { decision } = req.body;
    if (!['APPROVE', 'REJECT'].includes(decision)) fail(400, 'Quyết định không hợp lệ');
    const reason = req.body.reason === undefined ? null : textField(req.body.reason, 'reason', 10000, true);
    if (decision === 'REJECT' && !reason) fail(400, 'Phải nhập lý do trả lại');
    const reviewed = await prisma.$transaction(async (tx) => {
        const task = await tx.task.findUnique({ where: { id: req.params.id } });
        if (!task) fail(404, 'Không tìm thấy công việc');
        const submission = await tx.taskSubmission.findFirst({ where: { id: req.params.submissionId, taskId: task.id } });
        if (!submission) fail(404, 'Không tìm thấy lần gửi minh chứng');
        if (submission.submittedByUserId === req.user.id) fail(403, 'Không được tự duyệt minh chứng');
        if (task.status !== 'PENDING_REVIEW' || submission.status !== 'PENDING') fail(409, 'Lần gửi không còn chờ duyệt');
        const changed = await tx.task.updateMany({ where: { id: task.id, version: task.version, status: 'PENDING_REVIEW' }, data: { status: decision === 'APPROVE' ? 'COMPLETED' : 'IN_PROGRESS', version: { increment: 1 } } });
        if (changed.count !== 1) fail(409, 'Công việc đã thay đổi');
        return tx.taskSubmission.update({ where: { id: submission.id }, data: { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewedByUserId: req.user.id, reviewedAt: new Date(), reason } });
    });
    res.json({ message: decision === 'APPROVE' ? 'Đã duyệt hoàn thành công việc' : 'Đã trả lại công việc', data: reviewed });
}));

module.exports = router;
