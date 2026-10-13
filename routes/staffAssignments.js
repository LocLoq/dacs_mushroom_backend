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
        const record = await parent(prisma, req);
        const paging = pagination(req.query, 100, 20);
        const search = req.query.search === undefined ? null : textField(req.query.search, 'search', 255, true);
        if (req.query.available !== undefined && !['true','false'].includes(req.query.available)) fail(400, 'available phải là true hoặc false');
        if (req.query.available === 'true') {
            const parentId = id(req.params.id);
            const where = { role: { name: 'staff' },
                ...(batch ? { facilityMemberships: { some: { facilityId: record.facilityId } }, batchAssignments: { none: { batchId: parentId } } }
                    : { facilityMemberships: { none: { facilityId: parentId } } }),
                ...(search ? { OR: [{ username: { contains: search } }, { full_name: { contains: search } }] } : {}) };
            const [total, rows] = await Promise.all([prisma.user.count({ where }), prisma.user.findMany({
                where, skip: paging.skip, take: paging.limit, orderBy: [{ full_name: 'asc' }, { id: 'asc' }],
                select: { id: true, username: true, full_name: true }
            })]);
            return res.json(pageResponse(rows, total, paging));
        }
        const where = { [parentField]: id(req.params.id), ...(search ? { user: { OR: [{ username: { contains: search } }, { full_name: { contains: search } }] } } : {}) };
        const [total, rows] = await Promise.all([
            prisma[model].count({ where }), prisma[model].findMany({ where, skip: paging.skip, take: paging.limit,
                orderBy: [{ createdAt: 'desc' }, { userId: 'asc' }], include: { user: { select: { id: true, username: true, full_name: true } } } })
        ]);
        res.json(pageResponse(rows, total, paging));
    }));
    const audit = (action) => auditAction(`${kind.toUpperCase()}_STAFF_${action}`, { entityType: kind, entityId: (req) => req.params.id });
    router.post('/:id/staff', ...auth, audit('GRANT'), handle(async (req, res) => {
        fields(req.body, ['userId', 'userIds']);
        const bulk = req.body.userIds !== undefined;
        if (bulk && req.body.userId !== undefined || !bulk && req.body.userId === undefined) fail(400, 'Chỉ gửi userId hoặc userIds');
        if (bulk && (!Array.isArray(req.body.userIds) || !req.body.userIds.length || req.body.userIds.length > 100)) fail(400, 'Chọn từ 1 đến 100 nhân viên');
        const userIds = [...new Set((bulk ? req.body.userIds : [req.body.userId]).map(id))];
        const parentId = id(req.params.id);
        const result = await workflowTransaction(prisma, async tx => {
            const record = await parent(tx, req, true);
            const users = await tx.user.findMany({ where: { id: { in: userIds } }, include: { role: true } });
            const byId = new Map(users.map(user => [user.id,user]));
            const invalid = userIds.filter(userId => byId.get(userId)?.role.name !== 'staff');
            if (invalid.length) fail(400, 'Không thể phân công: ' + invalid.map(userId => byId.get(userId)?.full_name || byId.get(userId)?.username || ('ID ' + userId)).join(', ') + '. Chỉ chọn tài khoản nhân viên.', 'ASSIGNMENT_INELIGIBLE');
            if (batch) {
                const members = await tx.facilityStaff.findMany({ where: { facilityId: record.facilityId, userId: { in: userIds } }, select: { userId: true } });
                const eligible = new Set(members.map(member => member.userId));
                const invalid = userIds.filter(userId => !eligible.has(userId));
                if (invalid.length) fail(400, 'Nhân viên không còn thuộc cơ sở của lô: ' + invalid.map(userId => byId.get(userId).full_name || byId.get(userId).username).join(', '), 'ASSIGNMENT_INELIGIBLE');
            }
            const assignments = [], addedUserIds = [];
            for (const userId of userIds) {
                const where = { [key]: { [parentField]: parentId, userId } };
                let assignment = await tx[model].findUnique({ where });
                if (!assignment) {
                    assignment = await tx[model].create({ data: { [parentField]: parentId, userId, grantedByUserId: req.user.id } });
                    addedUserIds.push(userId);
                }
                assignments.push(assignment);
            }
            const notifications = await notifyUsers(tx, { recipients: addedUserIds, actorId: req.user.id, eventKey: crypto.randomUUID(),
                type: 'PERMISSION_GRANTED', title: batch ? 'Bạn được phân công lô nuôi trồng' : 'Bạn được thêm vào cơ sở sản xuất', batchId: batch ? parentId : null });
            return { assignments, notifications, addedUserIds };
        });
        await publishNotifications(result.notifications);
        if (result.addedUserIds.length) {
            await refreshUsers([...result.addedUserIds, req.user.id], 'permissions');
            await refreshUsers([...result.addedUserIds, req.user.id], 'tasks');
        }
        res.status(201).json(bulk ? { data: result.assignments, addedCount: result.addedUserIds.length } : { data: result.assignments[0] });
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
