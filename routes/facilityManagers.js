const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { auditAction } = require('../middlewares/audit');
const { id, fields, fail, pagination, pageResponse, textField, handle } = require('../services/apiHelpers');
const { requireFacilityAccess, workflowTransaction } = require('../services/access');
const { refreshUsers } = require('../services/workflowEvents');

const router = express.Router();
const prisma = global.prisma;
const auth = [authenticateToken, authorizeRoles('admin')];
const userSelect = { id: true, username: true, full_name: true };
const audit = (action) => auditAction(`FACILITY_MANAGER_${action}`, { entityType: 'ProductionFacility', entityId: req => req.params.id });

router.get('/:id/managers', ...auth, handle(async (req, res) => {
    const facilityId = id(req.params.id);
    await requireFacilityAccess(prisma, req.user, facilityId);
    const paging = pagination(req.query, 100, 20);
    const search = req.query.search === undefined ? '' : textField(req.query.search, 'search', 255, true);
    if (req.query.available !== undefined && !['true', 'false'].includes(req.query.available)) fail(400, 'available phải là true hoặc false');
    const userFilter = search ? { OR: [{ username: { contains: search } }, { full_name: { contains: search } }] } : {};
    if (req.query.available === 'true') {
        const where = { ...userFilter, role: { name: 'manager' }, facilityManagements: { none: { facilityId } } };
        const [total, rows] = await Promise.all([
            prisma.user.count({ where }),
            prisma.user.findMany({ where, select: userSelect, skip: paging.skip, take: paging.limit, orderBy: [{ full_name: 'asc' }, { id: 'asc' }] })
        ]);
        return res.json(pageResponse(rows, total, paging));
    }
    const where = { facilityId, user: { ...userFilter, role: { name: 'manager' } } };
    const [total, rows] = await Promise.all([
        prisma.facilityManager.count({ where }),
        prisma.facilityManager.findMany({ where, include: { user: { select: userSelect } }, skip: paging.skip, take: paging.limit, orderBy: [{ createdAt: 'desc' }, { userId: 'asc' }] })
    ]);
    res.json(pageResponse(rows, total, paging));
}));

router.post('/:id/managers', ...auth, audit('GRANT'), handle(async (req, res) => {
    fields(req.body, ['userId', 'userIds']);
    const bulk = req.body.userIds !== undefined;
    if (bulk && req.body.userId !== undefined || !bulk && req.body.userId === undefined) fail(400, 'Chỉ gửi userId hoặc userIds');
    if (bulk && (!Array.isArray(req.body.userIds) || !req.body.userIds.length || req.body.userIds.length > 100)) fail(400, 'Chọn từ 1 đến 100 manager');
    const userIds = [...new Set((bulk ? req.body.userIds : [req.body.userId]).map(id))];
    const facilityId = id(req.params.id);
    const result = await workflowTransaction(prisma, async tx => {
        await requireFacilityAccess(tx, req.user, facilityId, true);
        const users = await tx.user.findMany({ where: { id: { in: userIds }, role: { name: 'manager' } }, select: { id: true } });
        if (users.length !== userIds.length) fail(400, 'Chỉ chọn tài khoản manager còn tồn tại', 'ASSIGNMENT_INELIGIBLE');
        const assignments = [];
        let addedCount = 0;
        for (const userId of userIds) {
            const where = { facilityId_userId: { facilityId, userId } };
            let assignment = await tx.facilityManager.findUnique({ where });
            if (!assignment) {
                assignment = await tx.facilityManager.create({ data: { facilityId, userId, grantedByUserId: req.user.id } });
                addedCount++;
            }
            assignments.push(assignment);
        }
        return { assignments, addedCount };
    });
    await refreshUsers([...userIds, req.user.id], 'permissions');
    await refreshUsers(userIds, 'tasks');
    res.status(201).json(bulk ? { data: result.assignments, addedCount: result.addedCount } : { data: result.assignments[0] });
}));

router.delete('/:id/managers/:userId', ...auth, audit('REVOKE'), handle(async (req, res) => {
    const facilityId = id(req.params.id), userId = id(req.params.userId);
    await workflowTransaction(prisma, async tx => {
        await requireFacilityAccess(tx, req.user, facilityId, true);
        await tx.facilityManager.deleteMany({ where: { facilityId, userId } });
    });
    await refreshUsers([userId, req.user.id], 'permissions');
    await refreshUsers([userId], 'tasks');
    res.json({ message: 'Đã thu hồi quyền quản lý cơ sở' });
}));

module.exports = router;
