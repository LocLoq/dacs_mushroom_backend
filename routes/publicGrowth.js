const { fail, textField, handle } = require('../services/apiHelpers');
const express = require('express');

const router = express.Router();
const prisma = global.prisma;

router.get('/cultivation-batches/:batchCode/growth-progress/current', handle(async (req, res) => {
    const batchCode = textField(req.params.batchCode, 'batchCode', 191);

    const batch = await prisma.cultivationBatch.findUnique({
        where: { batchCode },
        select: {
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
    const { growthRecords, ...publicBatch } = batch;
    res.json({ data: { ...publicBatch, currentProgress: growthRecords[0] || null } });
}));

module.exports = router;
