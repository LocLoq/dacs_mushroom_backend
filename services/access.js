const { fail, id, handle } = require('./apiHelpers');

const batchScope = (user) => user.role === 'staff' ? {
    staffAssignments: { some: { userId: user.id } },
    facility: { staffMemberships: { some: { userId: user.id } } }
} : user.role === 'manager' ? { facility: facilityScope(user) } : {};
const facilityScope = (user) => user.role === 'staff' ? { staffMemberships: { some: { userId: user.id } } }
    : user.role === 'manager' ? { managerAssignments: { some: { userId: user.id } } } : {};
const managedStaffScope = (user) => ({ role: { name: 'staff' }, facilityMemberships: { some: { facility: facilityScope(user) } } });
const taskScope = (user) => user.role === 'staff' ? {
    assigneeUserId: user.id, OR: [{ batchId: null }, { batch: batchScope(user) }]
} : user.role === 'manager' ? { OR: [
    { batch: batchScope(user) },
    { batchId: null, assignee: managedStaffScope(user) },
    { batchId: null, assigneeUserId: null, createdByUserId: user.id, createdBy: { facilityManagements: { some: {} } } }
] } : {};

// All permission changes and batch writes lock the facility before the batch.
// This makes a successful revoke a boundary after which a staff write cannot commit.
async function lockFacility(client, facilityId) {
    await client.$queryRaw`SELECT id FROM production_facilities WHERE id = ${facilityId} FOR UPDATE`;
}
async function requireBatchAccess(client, user, batchId, lock = false) {
    let batch = await client.cultivationBatch.findUnique({ where: { id: batchId } });
    if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');
    if (lock) {
        await lockFacility(client, batch.facilityId);
        await client.$queryRaw`SELECT id FROM cultivation_batches WHERE id = ${batchId} FOR UPDATE`;
        const current = await client.cultivationBatch.findUnique({ where: { id: batchId } });
        if (!current) fail(404, 'Không tìm thấy lô nuôi trồng');
        if (current.facilityId !== batch.facilityId) fail(409, 'Cơ sở của lô đã thay đổi; vui lòng tải lại');
        batch = current;
    }
    if (user.role === 'staff') {
        const [membership, assignment] = await Promise.all([
            client.facilityStaff.findUnique({ where: { facilityId_userId: { facilityId: batch.facilityId, userId: user.id } } }),
            client.batchStaff.findUnique({ where: { batchId_userId: { batchId, userId: user.id } } })
        ]);
        if (!membership || !assignment) fail(403, 'Bạn không được phân công lô nuôi trồng này', 'AUTH_FORBIDDEN');
    }
    if (user.role === 'manager') await requireManagerFacility(client, user, batch.facilityId);
    return batch;
}
async function requireTaskAccess(client, user, task, lock = false) {
    if (!task) fail(404, 'Không tìm thấy công việc');
    if (user.role === 'staff' && task.assigneeUserId !== user.id) fail(403, 'Bạn không được giao công việc này', 'AUTH_FORBIDDEN');
    if (task.batchId !== null && task.batchId !== undefined) await requireBatchAccess(client, user, task.batchId, lock);
    else if (user.role === 'manager') {
        if (task.assigneeUserId == null && task.createdByUserId !== user.id) fail(403, 'Bạn không có quyền quản lý công việc này', 'AUTH_FORBIDDEN');
        await requireManagerAssignee(client, user, task.assigneeUserId, lock);
    }
    return task;
}
async function requireManagerFacility(client, user, facilityId) {
    if (!await client.facilityManager.findUnique({ where: { facilityId_userId: { facilityId, userId: user.id } } })) {
        fail(403, 'Bạn không quản lý cơ sở sản xuất này', 'AUTH_FORBIDDEN');
    }
}
// Lock candidate facilities before rechecking membership, using the same locks as revocation.
async function requireManagerAssignee(client, user, assigneeUserId, lock = false) {
    if (user.role !== 'manager') return;
    const where = assigneeUserId == null ? { userId: user.id }
        : { facility: facilityScope(user), userId: assigneeUserId, user: { role: { name: 'staff' } } };
    const model = assigneeUserId == null ? client.facilityManager : client.facilityStaff;
    let memberships = await model.findMany({ where, orderBy: { facilityId: 'asc' }, select: { facilityId: true } });
    if (!memberships.length) fail(403, 'Chỉ được giao việc cho nhân viên thuộc cơ sở bạn quản lý', 'AUTH_FORBIDDEN');
    if (lock) {
        for (const membership of memberships) await lockFacility(client, membership.facilityId);
        memberships = await model.findMany({ where, select: { facilityId: true } });
    }
    if (!memberships.length) fail(403, 'Chỉ được giao việc cho nhân viên thuộc cơ sở bạn quản lý', 'AUTH_FORBIDDEN');
}
async function requireFacilityAccess(client, user, facilityId, lock = false) {
    const facility = await client.productionFacility.findUnique({ where: { id: facilityId } });
    if (!facility) fail(404, 'Không tìm thấy cơ sở sản xuất');
    if (lock) await lockFacility(client, facilityId);
    if (user.role === 'staff' && !await client.facilityStaff.findUnique({ where: { facilityId_userId: { facilityId, userId: user.id } } })) {
        fail(403, 'Bạn không thuộc cơ sở sản xuất này', 'AUTH_FORBIDDEN');
    }
    if (user.role === 'manager') await requireManagerFacility(client, user, facilityId);
    return facility;
}
const batchAccessMiddleware = handle(async (req, res, next) => {
    await requireBatchAccess(global.prisma, req.user, id(req.params.id));
    next();
});
const workflowTransaction = (client, callback) => client.$transaction(callback, { isolationLevel: 'ReadCommitted' });
module.exports = { workflowTransaction, batchScope, facilityScope, managedStaffScope, taskScope, lockFacility, requireBatchAccess, requireTaskAccess, requireFacilityAccess, requireManagerAssignee, batchAccessMiddleware };
