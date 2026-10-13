const { refreshUsers } = require('./workflowEvents');

async function notifyUsers(tx, { recipients, actorId, eventKey, type, title, taskId = null, batchId = null }) {
    const notifications = [];
    for (const userId of new Set(recipients.filter((value) => Number.isInteger(value) && value !== actorId))) {
        const notification = await tx.notification.upsert({
            where: { userId_eventKey: { userId, eventKey } }, update: {},
            create: { userId, eventKey, type, title, taskId, batchId }
        });
        const devices = await tx.pushDevice.findMany({ where: { userId, active: true, provider: "fcm" }, select: { id: true } });
        for (const device of devices) await tx.pushDelivery.upsert({
            where: { notificationId_deviceId: { notificationId: notification.id, deviceId: device.id } },
            update: {}, create: { notificationId: notification.id, deviceId: device.id }
        });
        notifications.push(notification);
    }
    return notifications;
}
async function taskNotifications(tx, task, actorId, type, additionalRecipients = [], suffix = '') {
    const reviewers = type === 'TASK_SUBMITTED'
        ? (await tx.user.findMany({ where: { role: { name: { in: ['admin', 'manager'] } } }, select: { id: true } })).map((user) => user.id) : [];
    const titles = { TASK_CREATED: 'Bạn được giao công việc mới', TASK_UPDATED: 'Công việc đã được cập nhật', TASK_CANCELLED: 'Công việc đã bị hủy',
        TASK_SUBMITTED: 'Có công việc cần duyệt minh chứng', TASK_APPROVED: 'Minh chứng công việc đã được duyệt', TASK_REJECTED: 'Công việc được trả lại để bổ sung', TASK_DELETED: 'Công việc đã được xóa' };
    return notifyUsers(tx, { recipients: [task.assigneeUserId, task.createdByUserId, ...additionalRecipients, ...reviewers], actorId,
        eventKey: `${task.id}:${task.version || 0}:${type}:${suffix}`, type, title: titles[type], taskId: task.id, batchId: task.batchId });
}
async function publishNotifications(notifications, taskUsers = [], taskId) {
    try {
    const users = [...notifications.map((item) => item.userId), ...taskUsers];
    await refreshUsers(users, 'notifications');
    if (taskId) {
        const managers = global.io ? await global.prisma.user.findMany({ where: { role: { name: { in: ['admin', 'manager'] } } }, select: { id: true } }) : [];
        await refreshUsers([...users, ...managers.map((user) => user.id)], 'tasks', taskId);
    }
    } catch (error) { console.error('Notification refresh failed:', error.message); }
}
module.exports = { notifyUsers, taskNotifications, publishNotifications };
