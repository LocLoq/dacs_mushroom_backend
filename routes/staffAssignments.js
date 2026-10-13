const { workflowTransaction } = require('../services/access');
const express = require('express');
const crypto = require('crypto');
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { auditAction } = require('../middlewares/audit');
const { fail, id, fields, textField, pagination, pageResponse, handle } = require('../services/apiHelpers');
const { requireBatchAccess, requireFacilityAccess, lockFacility } = require('../services/access');
const { notifyUsers, publishNotifications } = require('../services/notifications');
const { refreshUsers } = require('../services/workflowEvents');

function createStaffRouter(kind) {
    const router = express.Router();
    const prisma = global.prisma;
    const batch = kind === 'batch';
    const model = batch ? 'batchStaff' : 'facilityStaff';
    const parentField = batch ? 'batchId' : 'facilityId';
    const key = `${parentField}_userId`;
    const auth = [authenticateToken, authorizeRoles('admin')];
    const parent = async (tx, req, lock = false) => {
        const parentId = id(req.params.id);
        if (batch) return requireBatchAccess(tx, req.user, parentId, lock);
        const facility = await requireFacilityAccess(tx, req.user, parentId);
        if (lock) await lockFacility(tx, parentId);
        return facility;
    };
    router.get('/:id/staff', ...auth, handle(async (req, res) => {
        await parent(prisma, req);
        const paging = pagination(req.query, 100, 20);
        const search = req.query.search === undefined ? null : textField(req.query.search, 'search', 255, true);
        const where = { [parentField]: id(req.params.id), ...(search ? { user: { OR: [{ username: { contains: search } }, { full_name: { contains: search } }] } } : {}) };
        const [total, rows] = await Promise.all([
            prisma[model].count({ where }), prisma[model].findMany({ where, skip: paging.skip, take: paging.limit,
                orderBy: [{ createdAt: 'desc' }, { userId: 'asc' }], include: { user: { select: { id: true, username: true, full_name: true } } } })
        ]);
        res.json(pageResponse(rows, total, paging));
    }));
    const audit = (action) => auditAction(`${kind.toUpperCase()}_STAFF_${action}`, { entityType: kind, entityId: (req) => req.params.id });
    router.post('/:id/staff', ...auth, audit('GRANT'), handle(async (req, res) => {
        fields(req.body, ['userId']);
        const userId = id(req.body.userId);
        const parentId = id(req.params.id);
        const result = await workflowTransaction(prisma, async (tx) => {
            const record = await parent(tx, req, true);
            const user = await tx.user.findUnique({ where: { id: userId }, include: { role: true } });
            if (!user || user.role.name !== 'staff') fail(400, 'Chỉ phân công tài khoản nhân viên');
            if (batch && !await tx.facilityStaff.findUnique({ where: { facilityId_userId: { facilityId: record.facilityId, userId } } })) {
                fail(400, 'Nhân viên phải thuộc cơ sở sản xuất của lô');
            }
            const where = { [key]: { [parentField]: parentId, userId } };
            const exists = await tx[model].findUnique({ where });
            const assignment = exists || await tx[model].create({ data: { [parentField]: parentId, userId, grantedByUserId: req.user.id } });
            const notifications = exists ? [] : await notifyUsers(tx, { recipients: [userId], actorId: req.user.id,
                eventKey: crypto.randomUUID(), type: 'PERMISSION_GRANTED', title: batch ? 'Bạn được phân công lô nuôi trồng' : 'Bạn được thêm vào cơ sở sản xuất', batchId: batch ? parentId : null });
            return { assignment, notifications };
        });
        await publishNotifications(result.notifications);
        await refreshUsers([userId, req.user.id], 'permissions');
        await refreshUsers([userId, req.user.id], 'tasks');
        res.status(201).json({ data: result.assignment });
    }));
    router.delete('/:id/staff/:userId', ...auth, audit('REVOKE'), handle(async (req, res) => {
        const userId = id(req.params.userId);
        const parentId = id(req.params.id);
        const notifications = await workflowTransaction(prisma, async (tx) => {
            await parent(tx, req, true);
            const removed = await tx[model].deleteMany({ where: { [parentField]: parentId, userId } });
            if (!batch) await tx.batchStaff.deleteMany({ where: { userId, batch: { facilityId: parentId } } });
            return removed.count ? notifyUsers(tx, { recipients: [userId], actorId: req.user.id, eventKey: crypto.randomUUID(),
                type: 'PERMISSION_REVOKED', title: batch ? 'Quyền lô nuôi trồng đã được thu hồi' : 'Quyền cơ sở sản xuất đã được thu hồi', batchId: batch ? parentId : null }) : [];
        });
        await publishNotifications(notifications);
        await refreshUsers([userId, req.user.id], 'permissions');
        await refreshUsers([userId, req.user.id], 'tasks');
        res.json({ message: 'Đã thu hồi quyền nhân viên' });
    }));
    return router;
}
module.exports = { createStaffRouter };
