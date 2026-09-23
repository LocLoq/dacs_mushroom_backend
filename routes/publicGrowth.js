const express = require('express');

const router = express.Router();
const prisma = global.prisma;

router.get('/cultivation-batches/:batchCode/growth-progress/current', async (req, res) => {
    try {
        const batchCode = typeof req.params.batchCode === 'string' ? req.params.batchCode.trim() : '';
        if (!batchCode || batchCode.length > 191) return res.status(400).json({ message: 'Mã lô không hợp lệ' });

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

        if (!batch) return res.status(404).json({ message: 'Không tìm thấy lô nuôi trồng' });
        const { growthRecords, ...publicBatch } = batch;
        res.json({ data: { ...publicBatch, currentProgress: growthRecords[0] || null } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi máy chủ' });
    }
});

module.exports = router;
