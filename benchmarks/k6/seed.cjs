// Dedicated benchmark database only. Never modify existing application records.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

const runId = process.env.BENCHMARK_RUN_ID;
const database = process.env.DATABASE_NAME;
if (!/^[a-z0-9]{4,16}$/.test(runId || '')) throw Error('BENCHMARK_RUN_ID must be 4–16 lowercase letters/digits');
if (!/^benchmark_[a-z0-9_]+$/.test(database || '') || process.env.BENCHMARK_DATABASE !== database) {
  throw Error('Use a dedicated benchmark_* database and set BENCHMARK_DATABASE equal to DATABASE_NAME');
}
for (const name of ['DATABASE_HOST', 'DATABASE_USER']) if (!process.env[name]) throw Error(`Missing ${name}`);
const prefix = `bn_${runId}_`;
const directory = path.resolve('.cache', 'benchmark', runId);
const manifestPath = path.join(directory, 'manifest.json');
const uploads = path.resolve(process.env.BENCHMARK_UPLOADS_DIR || 'uploads');
const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT || 3306), user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD || '', database, connectionLimit: 5 }) });

function verifiedImage() {
  const image = process.env.BENCHMARK_IMAGE;
  if (!image) throw Error('Set BENCHMARK_IMAGE to a real JPEG/PNG mushroom photo');
  const result = spawnSync(process.env.BENCHMARK_PYTHON || 'python', ['-c',
    'from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.verify(); print(im.format)', image], { encoding: 'utf8' });
  const format = result.stdout.trim();
  if (result.status !== 0 || !['JPEG', 'PNG'].includes(format)) throw Error('BENCHMARK_IMAGE must decode as JPEG or PNG using Pillow');
  const bytes = fs.readFileSync(image);
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw Error('BENCHMARK_IMAGE must be between 1 byte and 5 MiB');
  return { bytes, extension: format === 'JPEG' ? 'jpg' : 'png', mime: format === 'JPEG' ? 'image/jpeg' : 'image/png' };
}
function storedImage(folder, image) {
  const filename = `bn-${runId}-${crypto.randomUUID()}.${image.extension}`;
  fs.mkdirSync(path.join(uploads, folder), { recursive: true });
  fs.writeFileSync(path.join(uploads, folder, filename), image.bytes, { flag: 'wx' });
  return { imageUrl: `/uploads/${folder}/${filename}`, originalName: filename, mimeType: image.mime, fileSize: image.bytes.length };
}
function save(manifest, create = false) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: create ? 'wx' : 'w' });
}
async function seed() {
  const image = verifiedImage();
  const password = process.env.BENCHMARK_PASSWORD;
  if (!password || password.length < 12) throw Error('Set BENCHMARK_PASSWORD to at least 12 characters');
  const collisions = await Promise.all([
    prisma.user.count({ where: { username: { startsWith: prefix } } }),
    prisma.productionFacility.count({ where: { name: { startsWith: prefix } } }),
    prisma.mushroom.count({ where: { scientificName: { startsWith: prefix } } })
  ]);
  if (fs.existsSync(manifestPath) || collisions.some(Boolean)) throw Error('Run ID already exists; select a new ID');
  const smoke = process.env.BENCHMARK_PROFILE === 'smoke';
  const counts = smoke ? { admin: 1, manager: 1, staff: 2, guest: 6, batchesPerFacility: 2 }
    : { admin: 10, manager: 50, staff: 500, guest: 9440, batchesPerFacility: 5 };
  const manifest = { version: 1, runId, database, counts, createdAt: new Date().toISOString(), image: path.resolve(process.env.BENCHMARK_IMAGE), imageMime: image.mime,
    imageSha256: crypto.createHash('sha256').update(image.bytes).digest('hex'), seedSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), users: [], facilities: [], batches: [] };
  save(manifest, true);
  const passwordHash = await bcrypt.hash(password, 10);
  const roles = {};
  for (const name of ['admin', 'manager', 'staff']) roles[name] = await prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const users = {};
  for (const role of ['admin', 'manager', 'staff']) {
    users[role] = [];
    for (let i = 0; i < counts[role]; i++) {
      const username = `${prefix}${role}_${String(i).padStart(4, '0')}`;
      const user = await prisma.user.create({ data: { username, password_hash: passwordHash, full_name: `Benchmark ${role} ${i}`, phone_number: '0000000000', email: `${username}@example.test`, tokenver: 0, role_id: roles[role].id } });
      users[role].push(user); manifest.users.push({ id: user.id, username, role });
    }
    save(manifest);
  }
  const mushroom = await prisma.mushroom.create({ data: { scientificName: `${prefix}Pleurotus`, commonName: 'Nấm sò benchmark', family: 'Pleurotaceae', genus: 'Pleurotus', edibilityStatus: 'EDIBLE' } });
  manifest.mushroomId = mushroom.id;
  const publicPhoto = storedImage('gallery', image);
  await prisma.mushroomImage.create({ data: { mushroomId: mushroom.id, ...publicPhoto, isPublic: true, isCover: true, uploadedByUserId: users.admin[0].id } });
  for (let i = 0; i < counts.manager; i++) {
    const manager = users.manager[i];
    const facility = await prisma.productionFacility.create({ data: { name: `${prefix}facility_${i}`, address: 'Benchmark', facilityType: 'HOUSEHOLD', mushrooms: { connect: { id: mushroom.id } } } });
    manifest.facilities.push(facility.id);
    await prisma.facilityManager.create({ data: { facilityId: facility.id, userId: manager.id, grantedByUserId: users.admin[0].id } });
    await prisma.facilityImage.create({ data: { facilityId: facility.id, ...storedImage('gallery', image), isPublic: false, uploadedByUserId: manager.id } });
    const batches = [];
    for (let j = 0; j < counts.batchesPerFacility; j++) {
      const batch = await prisma.cultivationBatch.create({ data: { batchCode: `${prefix}${i}_${j}`, facilityId: facility.id, mushroomId: mushroom.id, startDate: new Date(), status: 'FRUITING' } });
      batches.push(batch); manifest.batches.push({ id: batch.id, code: batch.batchCode, facilityId: facility.id });
      await prisma.growthProgressRecord.create({ data: { batchId: batch.id, stage: 'FRUITING', notes: prefix, createdByUserId: manager.id } });
      await prisma.harvestRecord.create({ data: { batchId: batch.id, totalYieldKg: 1, notes: prefix, createdByUserId: manager.id } });
      await prisma.batchExpense.create({ data: { batchId: batch.id, name: prefix, category: 'MATERIAL', quantity: 1, unit: 'kg', unitPrice: 10, amount: 10, incurredAt: new Date(), createdByUserId: manager.id } });
      await prisma.batchSale.create({ data: { batchId: batch.id, quantityKg: 1, unitPrice: 20, amount: 20, soldAt: new Date(), createdByUserId: manager.id } });
    }
    const each = counts.staff / counts.manager;
    const assignments = [];
    for (let j = 0; j < each; j++) {
      const member = users.staff[i * each + j], batch = batches[j % batches.length];
      await prisma.facilityStaff.create({ data: { facilityId: facility.id, userId: member.id, grantedByUserId: manager.id } });
      await prisma.batchStaff.create({ data: { batchId: batch.id, userId: member.id, grantedByUserId: manager.id } });
      const care = await prisma.cultivationCareLog.create({ data: { batchId: batch.id, actionType: 'WATERING', notes: prefix, createdByUserId: member.id, images: { create: storedImage('care-logs', image) } } });
      const task = await prisma.task.create({ data: { title: `${prefix}task_${i}_${j}`, batchId: batch.id, assigneeUserId: member.id, createdByUserId: manager.id } });
      const notice = await prisma.notification.create({ data: { userId: member.id, eventKey: `${prefix}${i}_${j}`, type: 'TASK_CREATED', title: 'Benchmark', taskId: task.id, batchId: batch.id } });
      Object.assign(manifest.users.find(row => row.id === member.id), { facilityId: facility.id, batchId: batch.id, batchCode: batch.batchCode, taskId: task.id, careId: care.id, notificationId: notice.id, careImage: (await prisma.careLogImage.findFirst({ where: { careLogId: care.id } })).imageUrl });
      assignments.push({ facilityId: facility.id, batchId: batch.id, batchCode: batch.batchCode, staffId: member.id });
    }
    Object.assign(manifest.users.find(row => row.id === manager.id), { ...assignments[0], assignments });
    save(manifest);
  }
  const staffRows = manifest.users.filter(row => row.role === 'staff');
  const adminRows = manifest.users.filter(row => row.role === 'admin');
  for (let i = 0; i < adminRows.length; i++) {
    const assignments = staffRows.filter((_, index) => index % adminRows.length === i).map(row => ({ facilityId: row.facilityId, batchId: row.batchId, batchCode: row.batchCode, staffId: row.id }));
    Object.assign(adminRows[i], { ...assignments[0], assignments });
  }
  manifest.publicImage = publicPhoto.imageUrl;
  manifest.complete = true;
  save(manifest);
  console.log(`Seed complete: ${manifest.users.length} accounts, ${manifest.facilities.length} facilities, ${manifest.batches.length} batches. Manifest: ${manifestPath}`);
}

seed().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
