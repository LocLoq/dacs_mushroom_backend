const assert = require('node:assert/strict');
const { test } = require('node:test');
const { batchYear, formatBatchCode, createBatchWithCode } = require('../services/batchCode');
test('batch year uses Vietnam time across New Year and formatting has no 999 limit', () => {
  assert.equal(batchYear(new Date('2025-12-31T16:59:59Z')), 2025);
  assert.equal(batchYear(new Date('2025-12-31T17:00:00Z')), 2026);
  assert.equal(formatBatchCode(12, 2026, 1), 'LO-CS12-2026-001');
  assert.equal(formatBatchCode(12, 2026, 1000), 'LO-CS12-2026-1000');
});
test('transaction retries three conflicts and stops on domain failures', async () => {
  let calls = 0;
  const prisma = { $transaction: async callback => { if (++calls < 4) throw Object.assign(new Error('deadlock'), { code: 'P2034' }); return callback({ batchCodeCounter: { upsert: async () => ({ lastNumber: 7 }) }, cultivationBatch: { create: async ({ data }) => data } }); } };
  const result = await createBatchWithCode(prisma, { facilityId: 12, startDate: new Date('2026-01-01') });
  assert.equal(calls, 4); assert.equal(result.batchCode, 'LO-CS12-2026-007');
  calls = 0; prisma.$transaction = async () => { calls++; throw Object.assign(new Error('deadlock'), { code: 'P2034' }); };
  await assert.rejects(createBatchWithCode(prisma, { facilityId: 12 }), error => error.status === 409); assert.equal(calls, 4);
  calls = 0; prisma.$transaction = async () => { calls++; throw Object.assign(new Error('missing facility'), { code: 'P2003' }); };
  await assert.rejects(createBatchWithCode(prisma, {}), error => error.code === 'P2003'); assert.equal(calls, 1);
});
