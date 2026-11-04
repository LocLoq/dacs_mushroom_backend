const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mariadb = require('mariadb');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

const enabled = process.env.RUN_DB_INTEGRATION === '1';
const runId = `guard${crypto.randomBytes(4).toString('hex')}`;
const database = `benchmark_${runId}`;
let connection, prisma, env, created = false;

before(async () => {
  if (!enabled) return;
  require('../config/environment.cjs').loadEnvironment();
  const config = { host: process.env.DATABASE_HOST, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD || '', port: Number(process.env.DATABASE_PORT || 3306) };
  connection = await mariadb.createConnection(config);
  assert.match(database, /^benchmark_guard[a-f0-9]{8}$/);
  await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created = true;
  const url = new URL('mysql://localhost:3306/');
  url.hostname = config.host; url.port = String(config.port); url.username = config.user; url.password = config.password; url.pathname = `/${database}`;
  env = { ...process.env, DATABASE_NAME: database, DATABASE_URL: url.toString(), BENCHMARK_DATABASE: database, BENCHMARK_RUN_ID: runId, BENCHMARK_CLEANUP: runId };
  const pushed = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(pushed.status, 0, pushed.stderr);
  prisma = new PrismaClient({ adapter: new PrismaMariaDb({ ...config, database, connectionLimit: 5 }) });
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  if (connection) {
    assert.match(database, /^benchmark_guard[a-f0-9]{8}$/);
    if (created) await connection.query(`DROP DATABASE \`${database}\``);
    await connection.end();
  }
});

test('cleanup refuses foreign assignments and evidence, then preserves unrelated users', { skip: !enabled }, async () => {
  const role = await prisma.role.create({ data: { name: 'staff' } });
  const makeUser = username => prisma.user.create({ data: { username, password_hash: 'unused', full_name: username, phone_number: '', email: '', tokenver: 0, role_id: role.id } });
  const owned = await makeUser(`bn_${runId}_staff`), other = await makeUser('unrelated-staff');
  const mushroom = await prisma.mushroom.create({ data: { scientificName: `bn_${runId}_species`, commonName: 'Test', family: 'Test', genus: 'Test', edibilityStatus: 'EDIBLE' } });
  const facility = await prisma.productionFacility.create({ data: { name: `bn_${runId}_facility`, address: 'Test', facilityType: 'HOUSEHOLD' } });
  const batch = await prisma.cultivationBatch.create({ data: { batchCode: `bn_${runId}_batch`, facilityId: facility.id, mushroomId: mushroom.id, startDate: new Date() } });
  const cleanup = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'benchmarks', 'k6', 'cleanup.cjs')], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });

  await prisma.batchStaff.create({ data: { batchId: batch.id, userId: other.id } });
  assert.notEqual(cleanup().status, 0);
  assert.equal(await prisma.productionFacility.count({ where: { id: facility.id } }), 1);
  await prisma.batchStaff.delete({ where: { batchId_userId: { batchId: batch.id, userId: other.id } } });

  const foreignCare = await prisma.cultivationCareLog.create({ data: { batchId: batch.id, actionType: 'WATERING', notes: 'unrelated', createdByUserId: other.id } });
  assert.notEqual(cleanup().status, 0);
  assert.equal(await prisma.cultivationCareLog.count({ where: { id: foreignCare.id } }), 1);
  await prisma.cultivationCareLog.delete({ where: { id: foreignCare.id } });

  const result = cleanup();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await prisma.productionFacility.count({ where: { id: facility.id } }), 0);
  assert.equal(await prisma.user.count({ where: { id: owned.id } }), 0);
  assert.equal(await prisma.user.count({ where: { id: other.id } }), 1);
});
