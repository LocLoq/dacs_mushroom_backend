/* Idempotent, development-only demo data for reports, logs and pagination. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed production database');
for (const key of ['DATABASE_HOST', 'DATABASE_USER', 'DATABASE_NAME']) if (!process.env[key]) throw new Error(`Missing ${key}`);

const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ host: process.env.DATABASE_HOST, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME, port: Number(process.env.DATABASE_PORT || 3306), connectionLimit: 5 }) });
const reference = new Date(`${process.env.SEED_REFERENCE_DATE || '2026-09-23'}T12:00:00.000Z`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNUWODAwMDAxAAGAAwKAQTFBdYUAAAAAElFTkSuQmCC', 'base64');
const statuses = [['PREPARATION', 12], ['INCUBATION', 18], ['FRUITING', 20], ['HARVESTING', 15], ['COMPLETED', 25], ['FAILED', 10]];
const classifierStatuses = Array.from({ length: 300 }, (_, index) => index < 210 ? 'SUCCEEDED' : index < 255 ? 'FAILED' : index < 280 ? 'PROCESSING' : 'QUEUED');
const actions = ['LOGIN', 'POST_USERS', 'PUT_USERS', 'DELETE_USERS', 'POST_MUSHROOM_SPECIES', 'PUT_MUSHROOM_SPECIES', 'DELETE_MUSHROOM_SPECIES', 'POST_PRODUCTION_FACILITIES', 'PUT_PRODUCTION_FACILITIES', 'DELETE_PRODUCTION_FACILITIES', 'POST_CULTIVATION_BATCHES', 'PUT_CULTIVATION_BATCHES', 'DELETE_CULTIVATION_BATCHES', 'GROWTH_PROGRESS_CREATE', 'HARVEST_CREATE', 'CLASSIFIER_SUBMIT', 'CLASSIFIER_COMPLETED', 'CLASSIFIER_FAILED', 'REPORT_OVERVIEW_VIEW', 'REPORT_EXPORT', 'AUDIT_LOG_VIEW'];
const minusDays = (days) => new Date(reference.getTime() - days * 86400000);
const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

async function main() {
  const roleRows = {};
  for (const name of ['admin', 'manager', 'staff']) roleRows[name] = await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  const password_hash = await bcrypt.hash(process.env.DEMO_PASSWORD || 'Demo@12345', 10);
  const users = {};
  for (const [role, username] of [['admin', 'demo_admin'], ['manager', 'demo_manager'], ['staff', 'demo_staff']]) {
    users[role] = await prisma.user.upsert({ where: { username }, update: { full_name: `Demo ${role}`, phone_number: `09000000${roleRows[role].id}`, email: `${username}@example.test`, role_id: roleRows[role].id, password_hash, tokenver: 1 }, create: { username, full_name: `Demo ${role}`, phone_number: `09000000${roleRows[role].id}`, email: `${username}@example.test`, role_id: roleRows[role].id, password_hash, tokenver: 1 } });
  }
  const mushroomData = [
    ['DEMO-Pleurotus-ostreatus', 'Nấm sò', 'EDIBLE', 'EASY'], ['DEMO-Lentinula-edodes', 'Nấm hương', 'EDIBLE', 'MEDIUM'], ['DEMO-Hericium-erinaceus', 'Nấm hầu thủ', 'CHOICE', 'MEDIUM'], ['DEMO-Amanita-phalloides', 'Nấm tán độc', 'DEADLY', 'UNCULTIVABLE'], ['DEMO-Inocybe-erubescens', 'Nấm xơ', 'POISONOUS', 'HARD'], ['DEMO-Russula-emetic', 'Nấm giòn', 'INEDIBLE', 'MEDIUM']
  ];
  const mushrooms = [];
  for (const [scientificName, commonName, edibilityStatus, cultivationDifficulty] of mushroomData) mushrooms.push(await prisma.mushroom.upsert({ where: { scientificName }, update: { commonName, edibilityStatus, cultivationDifficulty }, create: { scientificName, commonName, family: 'DEMO-Family', genus: scientificName.split('-')[1], edibilityStatus, cultivationDifficulty, ecologyType: 'SAPROBIC', habitat: 'Dữ liệu demo', fruitingSeason: 'Quanh năm' } }));
  const facilityData = [['DEMO-FAC-01', 'Trang trại Demo Lâm Đồng', 'HOUSEHOLD', 'ACTIVE'], ['DEMO-FAC-02', 'HTX Demo Đà Lạt', 'COOPERATIVE', 'ACTIVE'], ['DEMO-FAC-03', 'Công ty Demo Tây Nguyên', 'ENTERPRISE', 'ACTIVE'], ['DEMO-FAC-04', 'HTX Demo Bảo Lộc', 'COOPERATIVE', 'SUSPENDED'], ['DEMO-FAC-05', 'Trang trại Demo Cũ', 'HOUSEHOLD', 'CLOSED']];
  const facilities = [];
  for (const [taxCode, name, facilityType, status] of facilityData) facilities.push(await prisma.productionFacility.upsert({ where: { taxCode }, update: { name, facilityType, status, mushrooms: { set: mushrooms.map(({ id }) => ({ id })) } }, create: { taxCode, name, address: 'Địa chỉ demo', province: 'Lâm Đồng', facilityType, status, capacityTonsPerYear: 100, totalAreaSqm: 500, mushrooms: { connect: mushrooms.map(({ id }) => ({ id })) } } }));
  const batchRows = []; let batchIndex = 0;
  for (const [status, count] of statuses) for (let occurrence = 0; occurrence < count; occurrence++, batchIndex++) {
    const batchCode = `DEMO-BATCH-${String(batchIndex + 1).padStart(3, '0')}`;
    const startDate = minusDays(30 + (batchIndex % 24) * 30 + Math.floor(batchIndex / 24) * 3);
    const expectedHarvestDate = new Date(startDate.getTime() + 45 * 86400000);
    const facility = facilities[batchIndex % facilities.length], mushroom = mushrooms[batchIndex % mushrooms.length];
    batchRows.push(await prisma.cultivationBatch.upsert({ where: { batchCode }, update: { facilityId: facility.id, mushroomId: mushroom.id, status, startDate, expectedHarvestDate, endDate: status === 'COMPLETED' || status === 'FAILED' ? minusDays(Math.max(1, 20 - batchIndex % 15)) : null, defectRate: batchIndex % 7 === 0 ? null : Number(((batchIndex % 15) * 1.3).toFixed(2)), notes: 'Dữ liệu demo' }, create: { batchCode, facilityId: facility.id, mushroomId: mushroom.id, status, substrateType: 'Mùn cưa', spawnSource: 'DEMO-SPAWN', bagQuantity: 1000 + batchIndex * 5, startDate, expectedHarvestDate, defectRate: batchIndex % 7 === 0 ? null : Number(((batchIndex % 15) * 1.3).toFixed(2)), notes: 'Dữ liệu demo' } }));
  }
  const demoBatchIds = batchRows.map(({ id }) => id);
  await prisma.growthProgressImage.deleteMany({ where: { growthProgress: { batchId: { in: demoBatchIds } } } });
  await Promise.all([prisma.cultivationCareLog.deleteMany({ where: { batchId: { in: demoBatchIds } } }), prisma.growthProgressRecord.deleteMany({ where: { batchId: { in: demoBatchIds } } }), prisma.harvestRecord.deleteMany({ where: { batchId: { in: demoBatchIds } } })]);
  const uploadDir = path.join(__dirname, '..', 'uploads', 'growth-progress'); await fs.promises.mkdir(uploadDir, { recursive: true });
  const growthRows = [];
  for (let index = 0; index < 240; index++) growthRows.push(await prisma.growthProgressRecord.create({ data: { batchId: batchRows[index % batchRows.length].id, stage: ['PREPARATION', 'INCUBATION', 'FRUITING', 'HARVESTING'][index % 4], notes: `Tiến trình demo ${index + 1}`, recordedAt: minusDays((index * 3) % 720) } }));
  await prisma.cultivationCareLog.createMany({ data: Array.from({ length: 300 }, (_, index) => ({ batchId: batchRows[index % 100].id, actionType: ['WATERING', 'VENTILATION', 'TEMPERATURE_CHECK'][index % 3], notes: `Chăm sóc demo ${index + 1}`, recordedAt: minusDays((index * 2) % 720) })) });
  await prisma.harvestRecord.createMany({ data: Array.from({ length: 180 }, (_, index) => ({ batchId: batchRows[65 + index % 35].id, harvestedAt: minusDays((index * 4) % 720), totalYieldKg: Number((8 + (index % 30) * 0.75).toFixed(2)), qualityGrade: ['A', 'B', 'C'][index % 3], notes: `Thu hoạch demo ${index + 1}` })) });
  for (let index = 0; index < 60; index++) { const filename = `demo-growth-${String(index + 1).padStart(3, '0')}.png`; await fs.promises.writeFile(path.join(uploadDir, filename), png); await prisma.growthProgressImage.create({ data: { growthProgressId: growthRows[index].id, imageUrl: `/uploads/growth-progress/${filename}`, originalName: filename, mimeType: 'image/png', fileSize: png.length } }); }
  for (const batch of batchRows) { const harvest = await prisma.harvestRecord.aggregate({ where: { batchId: batch.id }, _sum: { totalYieldKg: true } }); if (harvest._sum.totalYieldKg) await prisma.cultivationBatch.update({ where: { id: batch.id }, data: { actualYieldKg: harvest._sum.totalYieldKg } }); }
  const lookupIds = Array.from({ length: 300 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  await prisma.classifierLookup.deleteMany({ where: { id: { in: lookupIds } } });
  await prisma.classifierLookup.createMany({ data: classifierStatuses.map((status, index) => { const succeeded = status === 'SUCCEEDED'; const completed = succeeded || status === 'FAILED'; const name = ['Nấm sò', 'Nấm hương', 'Nấm hầu thủ', 'Nấm tán độc', 'Nấm xơ'][index % 5]; return { id: lookupIds[index], userId: index % 4 === 3 ? null : users[['admin', 'manager', 'staff'][index % 3]].id, originalName: `demo-classifier-${index + 1}.jpg`, mimeType: 'image/jpeg', fileSize: 10000 + index, status, predictedName: succeeded ? name : null, edibility: succeeded ? (index % 5 >= 3 ? 'POISONOUS' : 'NON_POISONOUS') : null, confidence: succeeded ? Number((0.61 + (index % 35) / 100).toFixed(2)) : null, errorMessage: status === 'FAILED' ? 'Dữ liệu lỗi demo' : null, result: succeeded ? { name, confidence: Number((0.61 + (index % 35) / 100).toFixed(2)), seeded: true } : null, queuedAt: minusDays((index * 2) % 720), startedAt: status === 'QUEUED' ? null : minusDays((index * 2) % 720), completedAt: completed ? minusDays((index * 2) % 720) : null }; }) });
  await prisma.auditLog.deleteMany({ where: { requestId: { startsWith: 'demo-audit-' } } });
  const auditRows = Array.from({ length: 2000 }, (_, index) => { const failure = index >= 1700; const actorName = index % 5 === 3 ? null : ['demo_admin', 'demo_manager', 'demo_staff', null, 'system'][index % 5]; const actorRole = actorName === 'demo_admin' ? 'admin' : actorName === 'demo_manager' ? 'manager' : actorName === 'demo_staff' ? 'staff' : null; const statusCode = failure ? [400, 401, 403, 404, 422, 500, 503][index % 7] : [200, 201][index % 2]; return { actorUserId: actorRole ? users[actorRole].id : null, actorUsername: actorName, actorRole, action: actions[index % actions.length], entityType: ['User', 'Mushroom', 'ProductionFacility', 'CultivationBatch', 'GrowthProgressRecord', 'HarvestRecord', 'ClassifierLookup', 'Report'][index % 8], entityId: String((index % 300) + 1), method: index % 3 === 0 ? 'GET' : index % 3 === 1 ? 'POST' : 'PUT', path: `/api/demo/${index % 25}`, statusCode, outcome: failure ? 'FAILURE' : 'SUCCESS', ipAddress: `10.0.${index % 25}.${(index % 200) + 1}`, userAgent: 'demo-seed/1.0', requestId: `demo-audit-${String(index + 1).padStart(5, '0')}`, durationMs: 5 + index % 900, metadata: { seeded: true, index }, createdAt: minusDays(index % 720) }; });
  for (const rows of chunk(auditRows, 500)) await prisma.auditLog.createMany({ data: rows });
  console.log(JSON.stringify({ seeded: true, referenceDate: reference.toISOString(), batches: 100, classifierLookups: 300, auditLogs: 2000 }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });
