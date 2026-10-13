const { resolveUser } = require('../middlewares/auth');
const { batchScope } = require('./access');

function configureWorkflowSocket(io) {
    const namespace = io.of('/workflow');
    namespace.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            const user = typeof token === 'string' ? await resolveUser(token) : null;
            if (!user || user.must_change_password) return next(new Error('AUTH_INVALID_TOKEN'));
            socket.data.token = token;
            socket.data.user = user;
            next();
        } catch { next(new Error('AUTH_INVALID_TOKEN')); }
    });
    namespace.on('connection', (socket) => { socket.join(`user_${socket.data.user.id}`); });
    return namespace;
}

async function refreshUsers(userIds, resource, id) {
    const namespace = global.io?.of('/workflow');
    if (!namespace) return;
    const recipients = new Set(userIds.filter(Number.isInteger));
    // Validate again: sockets may outlive a password change or a role change.
    await Promise.all([...namespace.sockets.values()].filter((socket) => recipients.has(socket.data.user?.id)).map(async (socket) => {
        try {
            const user = await resolveUser(socket.data.token);
            if (!user || user.must_change_password) return socket.disconnect(true);
            if (['batches', 'care-logs', 'growth-progress', 'harvests'].includes(resource) && id !== undefined && user.role === 'staff') {
                const allowed = await global.prisma.cultivationBatch.findFirst({ where: { id: Number(id), ...batchScope(user) }, select: { id: true } });
                if (!allowed) return;
            }
            socket.emit('refresh', { resource, ...(id === undefined ? {} : { id }) });
        } catch (error) { console.error('Workflow refresh failed:', error.message); }
    }));
}
async function batchRecipients(client, batchId) {
    const users = await client.user.findMany({ where: { OR: [
        { role: { name: { in: ['admin', 'manager'] } } },
        { role: { name: 'staff' }, batchAssignments: { some: { batchId } }, facilityMemberships: { some: { facility: { cultivationBatches: { some: { id: batchId } } } } } }
    ] }, select: { id: true } });
    return users.map((user) => user.id);
}
async function refreshBatch(batchId, resource = 'batches', extraUsers = []) {
    if (!global.io) return;
    try { await refreshUsers([...await batchRecipients(global.prisma, batchId), ...extraUsers], resource, batchId); }
    catch (error) { console.error('Batch refresh failed:', error.message); }
}
module.exports = { configureWorkflowSocket, refreshUsers, refreshBatch, batchRecipients };
