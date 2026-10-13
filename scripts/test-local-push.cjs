const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const { loadEnvironment } = require('../config/environment.cjs');
const { publicPushConfig } = require('../services/pushProviders');
const { notifyUsers, publishNotifications } = require('../services/notifications');
async function main() {
    loadEnvironment();
    const args = process.argv.slice(2);
    const username = args[args.indexOf('--username') + 1];
    const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : null;
    if (!args.includes('--username') || !username || username.startsWith('--') || platform && !['android', 'ios'].includes(platform)) {
        throw new Error('Usage: npm run push:test -- --username YOUR_APP_USERNAME [--platform android|ios]');
    }
    const config = publicPushConfig();
    const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT) || 3306, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME }) });
    try {
        const user = await prisma.user.findUnique({ where: { username }, select: { id: true, username: true } });
        if (!user) throw new Error('App user not found. Use the username from the users table.');
        const devices = await prisma.pushDevice.findMany({ where: { userId: user.id, active: true, ...(platform ? { platform } : {}) }, select: { id: true, provider: true, platform: true } });
        const ready = devices.filter(device => config.channels[device.provider]);
        if (!ready.length) throw new Error('No active devices on a configured channel. Login and register push on the phone first.');
        const notices = await prisma.$transaction(async tx => {
            const notice = await notifyUsers(tx, { recipients: [user.id], actorId: null, eventKey: `LOCAL_TEST:${crypto.randomUUID()}`, type: 'LOCAL_TEST', title: 'Thông báo thử nghiệm local' });
            if (platform) await tx.pushDelivery.updateMany({ where: { notificationId: notice[0].id, device: { platform: { not: platform } }, sentAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } });
            return notice;
        });
        await publishNotifications(notices);
        console.log(`Queued test notification for ${username}; ready devices: ${ready.length}. Allow up to 15 seconds for the outbox worker.`);
        console.log('Notification ID:', notices[0].id);
    } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
