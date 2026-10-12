const { fail } = require('./apiHelpers');

const batchYear = (startDate) => new Date(startDate.getTime() + 7 * 60 * 60 * 1000).getUTCFullYear();
const formatBatchCode = (facilityId, year, number) => `LO-CS${facilityId}-${year}-${String(number).padStart(3, '0')}`;

const createBatchWithCode = async (prisma, data) => {
    for (let attempt = 0; ; attempt++) {
        try {
            return await prisma.$transaction(async (tx) => {
                const year = batchYear(data.startDate);
                const counter = await tx.batchCodeCounter.upsert({
                    where: { facilityId_year: { facilityId: data.facilityId, year } },
                    create: { facilityId: data.facilityId, year, lastNumber: 1 },
                    update: { lastNumber: { increment: 1 } }
                });
                return tx.cultivationBatch.create({ data: { ...data, batchCode: formatBatchCode(data.facilityId, year, counter.lastNumber) }, include: { facility: true, mushroom: true } });
            });
        } catch (error) {
            const retryable = ['P2034', 'P2002'].includes(error.code) || [1213, 1205].includes(Number(error.errno || error.meta?.driverAdapterError?.cause?.originalCode));
            if (!retryable) throw error;
            if (attempt >= 3) fail(409, 'Không cấp được mã lô; vui lòng thử lại', 'STATE_CONFLICT');
        }
    }
};
module.exports = { batchYear, formatBatchCode, createBatchWithCode };
