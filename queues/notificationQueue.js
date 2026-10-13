const Queue = require('bull');
const { createProviderSenders } = require('../services/pushProviders');
const { pushConfig } = require('../config/push');
function createPushProcessor({ prisma, senders, now = () => new Date(), config = pushConfig() }) {
    return async job => {
        const delivery = await prisma.pushDelivery.findUnique({ where: { id: job.data.deliveryId }, include: { notification: true, device: true } });
        if (!delivery || delivery.sentAt || delivery.cancelledAt || delivery.attempts >= 5 || delivery.nextAttemptAt && delivery.nextAttemptAt > now()) return;
        const device = delivery.device;
        const cancel = () => prisma.pushDelivery.updateMany({ where: { id: delivery.id, sentAt: null, cancelledAt: null }, data: { cancelledAt: now() } });
        if (!device.active || device.userId !== delivery.notification.userId) { await cancel(); return; }
        const send = senders[device.provider]; if (!send) return;
        const registration = { id: device.id, userId: device.userId, registrationId: device.registrationId, active: true };
        try {
            await send(device, { notificationId: delivery.notification.id, userId: String(device.userId), registrationId: device.registrationId, origin: config.apiUrl });
            await prisma.pushDelivery.updateMany({ where: { id: delivery.id, cancelledAt: null, device: registration }, data: { sentAt: now(), lastError: null } });
        } catch (error) {
            if (error.kind === 'invalid') {
                if (error.invalidAt && Number(error.invalidAt) < device.updatedAt.getTime()) { await cancel(); return; }
                await prisma.$transaction(async tx => {
                    const changed = await tx.pushDevice.updateMany({ where: registration, data: { active: false } });
                    if (changed.count) await tx.pushDelivery.updateMany({ where: { deviceId: device.id, sentAt: null, cancelledAt: null }, data: { cancelledAt: now() } });
                }); return;
            }
            const configuration = error.kind === 'configuration';
            await prisma.pushDelivery.updateMany({ where: { id: delivery.id, cancelledAt: null, sentAt: null, device: registration }, data: {
                ...(configuration ? {} : { attempts: { increment: 1 } }),
                nextAttemptAt: new Date(now().getTime() + (configuration ? 300000 : 60000 * 2 ** delivery.attempts)), lastError: String(error.code || error.message || 'push-failed').slice(0, 255)
            } });
            if (!configuration) throw error;
        }
    };
}
function startNotificationWorker(prisma) {
    let senders;
    try { senders = createProviderSenders(); } catch (_) { console.error('Push host configuration unavailable'); return { close: async () => {} }; }
    const providers = Object.keys(senders); if (!providers.length) return { close: async () => {} };
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const queue = new Queue('workNotifications', redisUrl, { redis: { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000 } });
    const worker = new Queue('workNotifications', redisUrl);
    for (const instance of [queue, worker]) instance.on('error', error => console.error('Push queue error:', error.message));
    void worker.process(1, createPushProcessor({ prisma, senders })).catch(error => console.error('Push worker initialization failed:', error.message));
    worker.on('failed', job => console.error('Push delivery failed:', job.id));
    let running = false;
    const dispatch = async () => {
        if (running) return; running = true;
        try {
            const rows = await prisma.pushDelivery.findMany({ where: { sentAt: null, cancelledAt: null, attempts: { lt: 5 }, nextAttemptAt: { lte: new Date() }, device: { active: true, provider: { in: providers } } }, take: 100 });
            for (const row of rows) await queue.add({ deliveryId: row.id }, { jobId: row.id, removeOnComplete: true, removeOnFail: true });
        } catch (error) { console.error('Push outbox dispatch failed:', error.message); } finally { running = false; }
    };
    const timer = setInterval(dispatch, 15000); timer.unref(); void dispatch();
    return { close: async () => { clearInterval(timer); await Promise.all([queue.close(), worker.close()]); } };
}
module.exports = { startNotificationWorker, createPushProcessor };
