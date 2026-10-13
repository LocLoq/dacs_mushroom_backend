// Explicit permission fixtures for legacy route tests; production never bypasses ACL.
const crypto = require('crypto');
function workflowModels(prisma) {
    prisma.$queryRaw ||= async () => [];
    prisma.facilityStaff ||= { findMany: async () => [], findUnique: async ({ where }) => where.facilityId_userId };
    prisma.batchStaff ||= { findUnique: async ({ where }) => where.batchId_userId, findMany: async () => [], deleteMany: async () => ({ count: 0 }) };
    prisma.notification ||= { upsert: async ({ create }) => ({ id: crypto.randomUUID(), ...create }) };
    prisma.pushDevice ||= { findMany: async () => [] };
    const transaction = prisma.$transaction;
    prisma.$transaction = async (callback) => transaction ? transaction((tx) => callback({ ...prisma, ...tx, $queryRaw: tx.$queryRaw || prisma.$queryRaw, cultivationBatch: { ...prisma.cultivationBatch, ...tx.cultivationBatch }, batchStaff: tx.batchStaff || prisma.batchStaff, facilityStaff: tx.facilityStaff || prisma.facilityStaff, notification: tx.notification || prisma.notification, pushDevice: tx.pushDevice || prisma.pushDevice, productionFacility: tx.productionFacility || prisma.productionFacility })) : callback(prisma);
    return prisma;
}
module.exports = { workflowModels };
