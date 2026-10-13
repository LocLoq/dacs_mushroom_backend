const { fail, id, handle } = require('./apiHelpers');

const batchScope = (user) => user.role === 'staff' ? {
    staffAssignments: { some: { userId: user.id } },
    facility: { staffMemberships: { some: { userId: user.id } } }
} : {};
const facilityScope = (user) => user.role === 'staff' ? { staffMemberships: { some: { userId: user.id } } } : {};
const taskScope = (user) => user.role === 'staff' ? {
    assigneeUserId: user.id, OR: [{ batchId: null }, { batch: batchScope(user) }]
} : {};

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
    return batch;
}
async function requireTaskAccess(client, user, task, lock = false) {
    if (!task) fail(404, 'Không tìm thấy công việc');
    if (user.role === 'staff' && task.assigneeUserId !== user.id) fail(403, 'Bạn không được giao công việc này', 'AUTH_FORBIDDEN');
    if (task.batchId !== null && task.batchId !== undefined) await requireBatchAccess(client, user, task.batchId, lock);
    return task;
}
async function requireFacilityAccess(client, user, facilityId) {
    const facility = await client.productionFacility.findUnique({ where: { id: facilityId } });
    if (!facility) fail(404, 'Không tìm thấy cơ sở sản xuất');
    if (user.role === 'staff' && !await client.facilityStaff.findUnique({ where: { facilityId_userId: { facilityId, userId: user.id } } })) {
        fail(403, 'Bạn không thuộc cơ sở sản xuất này', 'AUTH_FORBIDDEN');
    }
    return facility;
}
const batchAccessMiddleware = handle(async (req, res, next) => {
    await requireBatchAccess(global.prisma, req.user, id(req.params.id));
    next();
});
const workflowTransaction = (client, callback) => client.$transaction(callback, { isolationLevel: 'ReadCommitted' });
module.exports = { workflowTransaction, batchScope, facilityScope, taskScope, lockFacility, requireBatchAccess, requireTaskAccess, requireFacilityAccess, batchAccessMiddleware };
