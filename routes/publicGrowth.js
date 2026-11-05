const { fail, textField, handle } = require('../services/apiHelpers');
const express = require('express');

const router = express.Router();
const prisma = global.prisma;
const { publicCache } = require('../services/publicCache');

router.get('/cultivation-batches/:batchCode/growth-progress/current', publicCache().middleware({ group: 'progress', ttl: Number(process.env.CACHE_PROGRESS_TTL || 15), key: req => ({ batchCode: textField(req.params.batchCode, 'batchCode', 191) }) }), handle(async (req, res) => {
    const batchCode = textField(req.params.batchCode, 'batchCode', 191);

    const batch = await prisma.cultivationBatch.findUnique({
        where: { batchCode },
        select: {
            id: true,
            batchCode: true,
            status: true,
            startDate: true,
            expectedHarvestDate: true,
            mushroom: { select: { commonName: true, scientificName: true, imageUrl: true } },
            facility: { select: { name: true, province: true } },
            growthRecords: {
                where: { recordedAt: { lte: new Date() } },
                orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
                take: 1,
                select: {
                    stage: true,
                    notes: true,
                    recordedAt: true,
                    updatedAt: true,
                    images: { select: { imageUrl: true }, orderBy: { id: 'asc' } }
                }
            }
        }
    });

    if (!batch) fail(404, 'Không tìm thấy lô nuôi trồng');
    if (publicCache().enabled && !req.headers.authorization) {
        const future = await prisma.growthProgressRecord.findFirst({ where: { batchId: batch.id, recordedAt: { gt: new Date() } }, orderBy: { recordedAt: 'asc' }, select: { recordedAt: true } });
        if (future) res.locals.cacheMaxSeconds = Math.floor((new Date(future.recordedAt).getTime() - Date.now()) / 1000);
    }
    const { id: _id, growthRecords, ...publicBatch } = batch;
    res.json({ data: { ...publicBatch, currentProgress: growthRecords[0] || null } });
}));

module.exports = router;
