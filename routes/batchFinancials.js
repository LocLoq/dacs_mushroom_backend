const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');
const { auditAction } = require('../middlewares/audit');
const { fail, id, pagination, pageResponse, fields, handle } = require('../services/apiHelpers');
const { entryData, financialSummary } = require('../services/financials');
const { requireBatchAccess } = require('../services/access');

const router = express.Router();
const prisma = global.prisma;
const authorize = [authenticateToken, authorizeRoles(...global.privilegedRoles)];

for (const kind of ['expenses', 'sales']) {
    const expense = kind === 'expenses';
    const model = expense ? 'batchExpense' : 'batchSale';
    const dateName = expense ? 'incurredAt' : 'soldAt';
    const allowed = expense ? ['name', 'category', 'quantity', 'unit', 'unitPrice', 'incurredAt', 'notes'] : ['quantityKg', 'unitPrice', 'soldAt', 'buyer', 'notes'];
    const audit = (action) => auditAction(`${expense ? 'EXPENSE' : 'SALE'}_${action}`, { entityType: expense ? 'BatchExpense' : 'BatchSale', entityId: (req, res) => res.locals.entryId || req.params.entryId || req.params.id });

    router.get(`/:id/${kind}`, audit('LIST'), ...authorize, handle(async (req, res) => {
        const batchId = id(req.params.id);
        const paging = pagination(req.query);
        await requireBatchAccess(prisma, req.user, batchId);
        const where = { batchId };
        const [total, rows] = await Promise.all([prisma[model].count({ where }), prisma[model].findMany({ where, skip: paging.skip, take: paging.limit, orderBy: [{ [dateName]: 'desc' }, { id: 'desc' }] })]);
        res.json(pageResponse(rows, total, paging));
    }));

    router.post(`/:id/${kind}`, audit('CREATE'), ...authorize, handle(async (req, res) => {
        const batchId = id(req.params.id);
        fields(req.body, allowed);
        const data = entryData(req.body, kind);
        const row = await prisma.$transaction(async tx => {
            await requireBatchAccess(tx, req.user, batchId, true);
            return tx[model].create({ data: { ...data, batchId, createdByUserId: req.user.id, updatedByUserId: req.user.id } });
        });
        res.locals.entryId = String(row.id);
        res.status(201).json({ message: 'Ghi nhận thành công', data: row });
    }));

    router.patch(`/:id/${kind}/:entryId`, audit('UPDATE'), ...authorize, handle(async (req, res) => {
        const batchId = id(req.params.id);
        const entryId = id(req.params.entryId);
        fields(req.body, allowed);
        const row = await prisma.$transaction(async (tx) => {
            await requireBatchAccess(tx, req.user, batchId, true);
            const existing = await tx[model].findFirst({ where: { id: entryId, batchId } });
            if (!existing) fail(404, 'Không tìm thấy khoản ghi nhận trong lô');
            return tx[model].update({ where: { id: entryId }, data: { ...entryData(req.body, kind, existing), updatedByUserId: req.user.id } });
        });
        res.json({ message: 'Cập nhật thành công', data: row });
    }));

    router.delete(`/:id/${kind}/:entryId`, audit('DELETE'), ...authorize, handle(async (req, res) => {
        const batchId = id(req.params.id);
        const removed = await prisma.$transaction(async tx => {
            await requireBatchAccess(tx, req.user, batchId, true);
            return tx[model].deleteMany({ where: { id: id(req.params.entryId), batchId } });
        });
        if (!removed.count) fail(404, 'Không tìm thấy khoản ghi nhận trong lô');
        res.json({ message: 'Xóa thành công' });
    }));
}

router.get('/:id/financial-summary', auditAction('BATCH_FINANCIAL_VIEW', { entityType: 'CultivationBatch', entityId: (req) => req.params.id }), ...authorize, handle(async (req, res) => {
    const batchId = id(req.params.id);
    await requireBatchAccess(prisma, req.user, batchId);
    const batch = await prisma.cultivationBatch.findUnique({ where: { id: batchId }, include: { sales: true, expenses: true, harvestRecords: true } });
    if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');
    res.json({ data: { batchId, ...financialSummary(batch.sales, batch.expenses, batch.harvestRecords) } });
}));

module.exports = router;
