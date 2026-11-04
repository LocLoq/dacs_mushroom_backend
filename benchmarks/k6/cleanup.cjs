// Deletes only resources explicitly scoped to a benchmark run in an isolated DB.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const runId = process.env.BENCHMARK_RUN_ID, database = process.env.DATABASE_NAME;
if (!/^[a-z0-9]{4,16}$/.test(runId || '') || !/^benchmark_[a-z0-9_]+$/.test(database || '') || process.env.BENCHMARK_DATABASE !== database) throw Error('Invalid run ID or dedicated benchmark database');
if (process.env.BENCHMARK_CLEANUP !== runId) throw Error('Set BENCHMARK_CLEANUP to the exact run ID');
const prefix = `bn_${runId}_`;
const uploads = path.resolve(process.env.BENCHMARK_UPLOADS_DIR || 'uploads');
const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT || 3306), user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD || '', database, connectionLimit: 5 }) });
async function main() {
  const [users, facilities, mushrooms] = await Promise.all([
    prisma.user.findMany({ where: { username: { startsWith: prefix } }, select: { id: true } }),
    prisma.productionFacility.findMany({ where: { name: { startsWith: prefix } }, select: { id: true } }),
    prisma.mushroom.findMany({ where: { scientificName: { startsWith: prefix } }, select: { id: true } })
  ]);
  const userIds = users.map(row => row.id), facilityIds = facilities.map(row => row.id), mushroomIds = mushrooms.map(row => row.id);
  const foreignCreator = { OR: [{ createdByUserId: null }, { createdByUserId: { notIn: userIds } }, { updatedByUserId: { notIn: userIds } }] };
  const foreignUploader = { OR: [{ uploadedByUserId: null }, { uploadedByUserId: { notIn: userIds } }] };
  const outside = await Promise.all([
    prisma.facilityManager.count({ where: { userId: { in: userIds }, facilityId: { notIn: facilityIds } } }),
    prisma.facilityStaff.count({ where: { userId: { in: userIds }, facilityId: { notIn: facilityIds } } }),
    prisma.task.count({ where: { AND: [{ OR: [{ createdByUserId: { in: userIds } }, { assigneeUserId: { in: userIds } }] }, { OR: [{ batchId: null }, { batch: { facilityId: { notIn: facilityIds } } }] }] } }),
    prisma.facilityManager.count({ where: { facilityId: { in: facilityIds }, userId: { notIn: userIds } } }),
    prisma.facilityStaff.count({ where: { facilityId: { in: facilityIds }, userId: { notIn: userIds } } }),
    prisma.batchStaff.count({ where: { userId: { in: userIds }, batch: { facilityId: { notIn: facilityIds } } } }),
    prisma.batchStaff.count({ where: { userId: { notIn: userIds }, batch: { facilityId: { in: facilityIds } } } }),
    prisma.task.count({ where: { batch: { facilityId: { in: facilityIds } }, OR: [{ createdByUserId: null }, { createdByUserId: { notIn: userIds } }, { assigneeUserId: { notIn: userIds } }] } }),
    prisma.taskSubmission.count({ where: { task: { batch: { facilityId: { in: facilityIds } } }, OR: [{ submittedByUserId: null }, { submittedByUserId: { notIn: userIds } }, { reviewedByUserId: { notIn: userIds } }] } }),
    ...['cultivationCareLog', 'growthProgressRecord', 'harvestRecord', 'batchExpense', 'batchSale'].map(model => prisma[model].count({ where: { batch: { facilityId: { in: facilityIds } }, ...foreignCreator } })),
    prisma.facilityImage.count({ where: { facilityId: { in: facilityIds }, ...foreignUploader } }),
    prisma.batchImage.count({ where: { batch: { facilityId: { in: facilityIds } }, ...foreignUploader } }),
    prisma.mushroomImage.count({ where: { mushroomId: { in: mushroomIds }, ...foreignUploader } }),
    prisma.productionFacility.count({ where: { id: { in: facilityIds }, mushrooms: { some: { id: { notIn: mushroomIds } } } } }),
    prisma.mushroom.count({ where: { id: { in: mushroomIds }, facilities: { some: { id: { notIn: facilityIds } } } } }),
    prisma.cultivationBatch.count({ where: { facilityId: { in: facilityIds }, mushroomId: { notIn: mushroomIds } } })
  ]);
  if (outside.some(Boolean)) throw Error('Run users are referenced outside the run facilities; cleanup refused');
  const batches = await prisma.cultivationBatch.findMany({ where: { facilityId: { in: facilityIds } }, select: { id: true } });
  const batchIds = batches.map(row => row.id);
  const imageSets = await Promise.all([
    prisma.facilityImage.findMany({ where: { facilityId: { in: facilityIds } }, select: { imageUrl: true } }),
    prisma.mushroomImage.findMany({ where: { mushroomId: { in: mushroomIds } }, select: { imageUrl: true } }),
    prisma.careLogImage.findMany({ where: { careLog: { batchId: { in: batchIds } } }, select: { imageUrl: true } }),
    prisma.growthProgressImage.findMany({ where: { growthProgress: { batchId: { in: batchIds } } }, select: { imageUrl: true } }),
    prisma.batchImage.findMany({ where: { batchId: { in: batchIds } }, select: { imageUrl: true } })
  ]);
  await prisma.$transaction(async tx => {
    await tx.taskSubmission.deleteMany({ where: { task: { batchId: { in: batchIds } } } });
    await tx.task.deleteMany({ where: { batchId: { in: batchIds } } });
    await tx.classifierLookup.deleteMany({ where: { userId: { in: userIds } } });
    await tx.cultivationBatch.deleteMany({ where: { id: { in: batchIds } } });
    await tx.productionFacility.deleteMany({ where: { id: { in: facilityIds }, name: { startsWith: prefix } } });
    await tx.mushroom.deleteMany({ where: { id: { in: mushroomIds }, scientificName: { startsWith: prefix } } });
    await tx.user.deleteMany({ where: { id: { in: userIds }, username: { startsWith: prefix } } });
  }, { timeout: 120000, isolationLevel: 'ReadCommitted' });
  let files = 0;
  for (const { imageUrl } of imageSets.flat()) {
    const match = imageUrl.match(/^\/uploads\/(gallery|care-logs|growth-progress)\/(bn-[a-z0-9]+-[\w.-]+)$/);
    if (!match || !match[2].startsWith(`bn-${runId}-`)) continue;
    const filename = path.join(uploads, match[1], match[2]);
    try { fs.unlinkSync(filename); files++; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log(`Removed run ${runId}: ${userIds.length} users, ${facilityIds.length} facilities, ${batchIds.length} batches and ${files} named seed images. Anonymous classifier history and generated upload files are retained for independent cleanup.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
