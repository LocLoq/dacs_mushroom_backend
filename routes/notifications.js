const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { fields, textField, fail, pagination, pageResponse, handle } = require('../services/apiHelpers');
const { refreshUsers } = require('../services/workflowEvents');
const { randomUUID } = require('node:crypto');
const { validateDevice } = require('../config/push');
const { publicPushConfig } = require('../services/pushProviders');
const router = express.Router();
const prisma = global.prisma;
router.use(authenticateToken, authorizeRoles(...global.allRoles));
router.get('/', handle(async (req, res) => {
    const paging = pagination(req.query, 50, 20);
    if (req.query.unread !== undefined && !['true', 'false'].includes(req.query.unread)) fail(400, 'unread không hợp lệ');
    const where = { userId: req.user.id, ...(req.query.unread === 'true' && { readAt: null }) };
    const [data, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({ where, skip: paging.skip, take: paging.limit, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], omit: { eventKey: true } }),
        prisma.notification.count({ where }), prisma.notification.count({ where: { userId: req.user.id, readAt: null } })
    ]);
    res.json({ ...pageResponse(data, total, paging), unreadCount });
}));
router.get('/push-config', handle(async (req, res) => res.json({ data: publicPushConfig() })));
router.get('/:id', handle(async (req,res) => {
    const row = await prisma.notification.findFirst({ where: { id: req.params.id, userId: req.user.id }, omit: { eventKey: true } });
    if (!row) fail(404, 'Không tìm thấy thông báo');
    res.json({ data: row });
}));
router.post('/read-all', handle(async (req, res) => {
    await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
    await refreshUsers([req.user.id], 'notifications');
    res.json({ message: 'Đã đánh dấu tất cả thông báo đã đọc' });
}));
router.patch('/:id/read', handle(async (req, res) => {
    const result = await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user.id }, data: { readAt: new Date() } });
    if (!result.count) fail(404, 'Không tìm thấy thông báo');
    await refreshUsers([req.user.id], 'notifications');
    res.json({ message: 'Đã đọc thông báo' });
}));
router.put('/devices', handle(async (req, res) => {
    fields(req.body, ['token', 'platform', 'provider', 'keys', 'apnsEnvironment']);
    let data;
    try { data = validateDevice(req.body); } catch (error) { fail(400, error.message); }
    const device = await prisma.$transaction(async (tx) => {
        const existing = await tx.pushDevice.findUnique({ where: { identityHash: data.identityHash } });
        const unchanged = existing && existing.active && existing.userId === req.user.id && existing.p256dh === data.p256dh && existing.auth === data.auth;
        const registrationId = unchanged ? existing.registrationId : randomUUID();
        if (existing && !unchanged) await tx.pushDelivery.updateMany({ where: { deviceId: existing.id, sentAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } });
        return tx.pushDevice.upsert({ where: { identityHash: data.identityHash }, create: { ...data, userId: req.user.id, active: true, registrationId }, update: { ...data, userId: req.user.id, active: true, registrationId } });
    }, { isolationLevel: 'Serializable' });
    res.json({ message: 'Đã đăng ký thiết bị', data: { registrationId: device.registrationId } });
}));
router.delete('/devices', handle(async (req, res) => {
    fields(req.body, ['token', 'provider', 'apnsEnvironment', 'registrationId']);
    const token = textField(req.body.token, 'token', 8192);
    if (typeof req.body.registrationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.body.registrationId)) fail(400, 'Invalid registrationId');
    await prisma.$transaction(async (tx) => {
        const where = { token, userId: req.user.id, registrationId: req.body.registrationId, active: true };
        const devices = await tx.pushDevice.findMany({ where, select: { id: true } });
        await tx.pushDevice.updateMany({ where, data: { active: false } });
        await tx.pushDelivery.updateMany({ where: { deviceId: { in: devices.map(device => device.id) }, sentAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } });
    }, { isolationLevel: 'Serializable' });
    res.json({ message: 'Đã hủy đăng ký thiết bị' });
}));
module.exports = router;
