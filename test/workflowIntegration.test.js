const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const jwt = require('jsonwebtoken');
const mariadb = require('mariadb');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

const enabled = process.env.RUN_DB_INTEGRATION === '1';
const database = `dacs_feature_test_${crypto.randomBytes(8).toString('hex')}`;
let connection;
let prisma;
let server;
let baseUrl;
let manager;
let admin;
let staff;
let other;
let batch;
let secondBatch;
let species;
let facility;
const uploadedUrls = new Set();
const token = (user) => jwt.sign({ id: user.id, username: user.username, tokenver: 0 }, process.env.JWT_SECRET);
const request = async (url, user = manager, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${baseUrl}${url}`, { method, headers: { ...(user ? { authorization: `Bearer ${token(user)}` } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
    const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: data };
};
const createTask = async (assignee = staff, batchId = batch.id) => {
    const result = await request('/dashboard/tasks', manager, { title: 'Kiểm tra sinh trưởng', batchId, assigneeUserId: assignee.id });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.data;
};
const createGrowth = async (user = staff, batchId = batch.id) => {
    const result = await request(`/cultivation-batches/${batchId}/growth-progress`, user, { stage: 'FRUITING', notes: 'Đã kiểm tra' });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.data;
};

before(async () => {
    if (!enabled) return;
    require('../config/environment.cjs').loadEnvironment();
    process.env.JWT_SECRET = 'isolated-workflow-integration-secret';
    const config = { host: process.env.DATABASE_HOST, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, port: Number(process.env.DATABASE_PORT) || 3306 };
    connection = await mariadb.createConnection(config);
    assert.match(database, /^dacs_feature_test_[a-f0-9]{16}$/);
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.query(`USE \`${database}\``);
    for (const filename of ['test/fixtures/pre_workflow_schema.sql', 'sql/workflow_finance_gallery.sql', 'sql/gallery_visibility.sql', 'sql/classifier_resilience.sql', 'sql/account_password_batch_codes.sql', 'sql/staff_care_notifications.sql', 'sql/unifiedpush_apns.sql', 'sql/firebase_push.sql', 'sql/push_device_origin.sql']) {
        if (filename === 'sql/account_password_batch_codes.sql') await connection.query("INSERT INTO cultivation_batches (batch_code,facility_id,mushroom_id,start_date,updated_at) VALUES ('LO-CS12-2026-099',1,1,NOW(3),NOW(3))");
        const statements = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8').split(';').map((statement) => statement.trim()).filter(Boolean);
        for (const statement of statements) await connection.query(statement);
        if (filename.includes('pre_workflow_schema')) {
            await connection.query("INSERT INTO roles (name) VALUES ('legacy')");
            await connection.query("INSERT INTO users (username,password_hash,full_name,phone_number,email,role_id,tokenver) VALUES ('legacy','unused','Legacy','','',1,0)");
            await connection.query("INSERT INTO mushroom_species (scientific_name,common_name,family,genus,edibility_status,updated_at) VALUES ('Legacy species','Legacy','Legacy','Legacy','EDIBLE',NOW(3))");
            await connection.query("INSERT INTO production_facilities (name,address,facility_type,updated_at) VALUES ('Legacy','Legacy','HOUSEHOLD',NOW(3))");
            await connection.query("INSERT INTO cultivation_batches (batch_code,facility_id,mushroom_id,start_date,updated_at) VALUES ('LEGACY',1,1,NOW(3),NOW(3))");
            await connection.query("INSERT INTO tasks (id,title,status,batch_id,updated_at) VALUES ('legacy-task','Already complete','COMPLETED',1,NOW(3))");
            await connection.query("INSERT INTO growth_progress_records (batch_id,stage,notes) VALUES (1,'FRUITING','Legacy note')");
        }
        if (filename === 'sql/staff_care_notifications.sql') {
            await connection.query("INSERT INTO notifications (id,user_id,event_key,type,title) VALUES ('legacy-notice',1,'migration-history','TASK_UPDATED','Legacy')");
            await connection.query("INSERT INTO push_devices (id,user_id,token,platform,updated_at) VALUES ('legacy-device',1,'old-registration','android',NOW(3))");
            await connection.query("INSERT INTO push_deliveries (id,notification_id,device_id,sent_at) VALUES ('legacy-pending','legacy-notice','legacy-device',NULL)");
            await connection.query("INSERT INTO notifications (id,user_id,event_key,type,title) VALUES ('legacy-sent-notice',1,'migration-sent','TASK_UPDATED','Sent')");
            await connection.query("INSERT INTO push_deliveries (id,notification_id,device_id,sent_at) VALUES ('legacy-sent','legacy-sent-notice','legacy-device',NOW(3))");
        }
        if (filename === 'sql/unifiedpush_apns.sql') {
            const devices = await connection.query("SELECT active,provider FROM push_devices WHERE id='legacy-device'");
            assert.equal(devices[0].active, 0); assert.equal(devices[0].provider, 'legacy');
            const history = await connection.query("SELECT id,sent_at,cancelled_at FROM push_deliveries WHERE device_id='legacy-device' ORDER BY id");
            assert.equal(history.length, 2); assert.ok(history[0].cancelled_at); assert.equal(history[0].sent_at, null);
            assert.equal(history[1].cancelled_at, null); assert.ok(history[1].sent_at);
            await connection.query("INSERT INTO push_devices (id,user_id,token,platform,updated_at,identity_hash,provider,active,registration_id) VALUES ('retired-unified',1,'http://old.example/upTest','android',NOW(3),REPEAT('f',64),'unifiedpush',true,UUID())");
            await connection.query("INSERT INTO push_deliveries (id,notification_id,device_id) VALUES ('retired-pending','legacy-notice','retired-unified')");
            await connection.query("INSERT INTO push_deliveries (id,notification_id,device_id,sent_at) VALUES ('retired-sent','legacy-sent-notice','retired-unified',NOW(3))");
        }
        if (filename === 'sql/firebase_push.sql') {
            const retired = await connection.query("SELECT active FROM push_devices WHERE id='retired-unified'");
            assert.equal(retired[0].active,0);
            const rows = await connection.query("SELECT id,sent_at,cancelled_at FROM push_deliveries WHERE device_id='retired-unified' ORDER BY id");
            assert.equal(rows.length,2); assert.ok(rows[0].cancelled_at); assert.equal(rows[0].sent_at,null);
            assert.equal(rows[1].cancelled_at,null); assert.ok(rows[1].sent_at);
        }
        if (filename === 'sql/workflow_finance_gallery.sql') {
            for (const [table, parentField] of [['facility_images', 'facility_id'], ['mushroom_images', 'mushroom_id'], ['batch_images', 'batch_id']]) {
                await connection.query(`INSERT INTO ${table} (${parentField},image_url,original_name,mime_type,file_size) VALUES (1,'/uploads/gallery/legacy.png','legacy.png','image/png',1)`);
            }
        }
    }
    prisma = new PrismaClient({ adapter: new PrismaMariaDb({ ...config, database, connectionLimit: 8 }) });
    global.prisma = prisma;
    global.allRoles = ['admin', 'manager', 'staff'];
    global.privilegedRoles = ['admin', 'manager'];
    const managerRole = await prisma.role.create({ data: { name: 'manager' } });
    const staffRole = await prisma.role.create({ data: { name: 'staff' } });
    const userData = (username, role_id) => ({ username, password_hash: 'unused', full_name: username, phone_number: '', email: '', role_id, tokenver: 0 });
    const adminRole = await prisma.role.create({ data: { name: 'admin' } });
    admin = await prisma.user.create({ data: userData('admin', adminRole.id) });
    manager = await prisma.user.create({ data: userData('manager', managerRole.id) });
    staff = await prisma.user.create({ data: userData('staff', staffRole.id) });
    other = await prisma.user.create({ data: userData('other', staffRole.id) });
    species = await prisma.mushroom.create({ data: { scientificName: 'Test species', commonName: 'Nấm thử', family: 'Test', genus: 'Test', edibilityStatus: 'EDIBLE', imageUrl: 'https://example.test/legacy.jpg' } });
    facility = await prisma.productionFacility.create({ data: { name: 'Trại thử', address: 'Đà Lạt', facilityType: 'HOUSEHOLD' } });
    batch = await prisma.cultivationBatch.create({ data: { batchCode: 'TEST-001', facilityId: facility.id, mushroomId: species.id, startDate: new Date('2025-01-01') } });
    secondBatch = await prisma.cultivationBatch.create({ data: { batchCode: 'TEST-002', facilityId: facility.id, mushroomId: species.id, startDate: new Date('2025-01-01') } });
    for (const member of [staff, other]) {
        await prisma.facilityStaff.create({ data: { userId: member.id, facilityId: facility.id } });
        for (const assigned of [batch, secondBatch]) await prisma.batchStaff.create({ data: { userId: member.id, batchId: assigned.id } });
    }
    const app = express();
    app.use(express.json());
    app.use('/api', require('../routes/login'));
    app.use('/uploads', require('../middlewares/galleryMedia').galleryMediaAccess, express.static(path.join(__dirname, '..', 'uploads')));
    app.use('/api/admin', require('../routes/admin'));
    app.use('/api/notifications', require('../routes/notifications'));
    app.use('/api/dashboard', require('../routes/dashboard'));
    app.use('/api/cultivation-batches', require('../routes/cultivationBatchManagement'));
    app.use('/api/mushroom-species', require('../routes/mushroomSpeciesManagement'));
    app.use('/api/production-facilities', require('../routes/productionFacilityManagement'));
    app.use('/api/reports', require('../routes/reports'));
    server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (prisma) await prisma.$disconnect();
    if (connection) {
        assert.match(database, /^dacs_feature_test_[a-f0-9]{16}$/);
        await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
        await connection.end();
    }
    for (const url of uploadedUrls) {
        assert.match(url, /^\/uploads\/(gallery|growth-progress|care-logs)\/[a-f0-9-]+\.(png|jpg|webp)$/);
        await fs.promises.unlink(path.join(__dirname, '..', url.slice(1))).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
});

test('SQL upgrade matches Prisma schema and preserves existing records', { skip: !enabled }, async () => {
    const legacyTask = await prisma.task.findUnique({ where: { id: 'legacy-task' } });
    assert.equal(legacyTask.status, 'COMPLETED');
    assert.equal(legacyTask.version, 0);
    const legacyRecord = await prisma.growthProgressRecord.findFirst({ where: { notes: 'Legacy note' } });
    assert.equal(legacyRecord.createdByUserId, null);
    assert.equal(legacyRecord.updatedByUserId, null);
    for (const model of ['facilityImage', 'mushroomImage', 'batchImage']) {
        const image = await prisma[model].findFirst({ where: { originalName: 'legacy.png' } });
        assert.equal(image.isPublic, false);
    }
    const configUrl = `mysql://${encodeURIComponent(process.env.DATABASE_USER)}:${encodeURIComponent(process.env.DATABASE_PASSWORD || '')}@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT || 3306}/${database}`;
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: configUrl, DATABASE_NAME: database } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('QR batch lookup resolves exact codes for staff and refuses guests', { skip: !enabled }, async () => {
    const code = 'LO / Đà Lạt #01?%';
    const record = await prisma.cultivationBatch.create({ data: { batchCode: code, facilityId: facility.id, mushroomId: species.id, startDate: new Date() } });
    await prisma.batchStaff.create({ data: { batchId: record.id, userId: staff.id } });
    try {
        const resolved = await request(`/cultivation-batches/by-code/${encodeURIComponent(` ${code} `)}`, staff);
        assert.equal(resolved.status, 200);
        assert.deepEqual(resolved.body, { data: { id: record.id, batchCode: code } });
        assert.equal((await request(`/cultivation-batches/by-code/${encodeURIComponent(code)}`, null)).status, 401);
        assert.equal((await request('/cultivation-batches/by-code/NOT-EXISTING', staff)).status, 404);
    } finally { await prisma.cultivationBatch.delete({ where: { id: record.id } }); }
});

test('task rejection, resubmission, immutable snapshot and approval', { skip: !enabled }, async () => {
    const task = await createTask();
    const record = await createGrowth();
    const candidates = await request(`/dashboard/tasks/${task.id}/evidence-candidates?type=GROWTH_PROGRESS`, staff);
    assert.equal(candidates.status, 200);
    assert.ok(candidates.body.data.some((item) => item.recordId === record.id));
    let result = await request(`/dashboard/tasks/${task.id}/submissions`, staff, { evidence: [{ type: 'GROWTH_PROGRESS', recordId: record.id }] });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const submissionId = result.body.data.id;
    assert.equal((await prisma.task.findUnique({ where: { id: task.id } })).status, 'PENDING_REVIEW');
    assert.equal((await request(`/dashboard/tasks/${task.id}`, staff, { status: 'COMPLETED' }, 'PATCH')).status, 403);
    assert.equal((await request(`/dashboard/tasks/${task.id}`, manager, { batchId: secondBatch.id }, 'PATCH')).status, 409);
    assert.equal((await request(`/dashboard/tasks/${task.id}/submissions/${submissionId}/review`, manager, { decision: 'REJECT' })).status, 400);
    result = await request(`/dashboard/tasks/${task.id}/submissions/${submissionId}/review`, manager, { decision: 'REJECT', reason: 'Bổ sung ghi chú' });
    assert.equal(result.status, 200);
    assert.equal((await prisma.task.findUnique({ where: { id: task.id } })).status, 'IN_PROGRESS');
    result = await request(`/cultivation-batches/${batch.id}/growth-progress/${record.id}`, staff, { notes: 'Đã bổ sung' }, 'PATCH');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.updatedByUserId, staff.id);
    result = await request(`/dashboard/tasks/${task.id}/submissions`, staff, { evidence: [{ type: 'GROWTH_PROGRESS', recordId: record.id }] });
    assert.equal(result.status, 201);
    const secondId = result.body.data.id;
    assert.equal((await request(`/dashboard/tasks/${task.id}/submissions/${submissionId}/review`, manager, { decision: 'APPROVE' })).status, 409);
    assert.equal((await request(`/dashboard/tasks/${task.id}/submissions/${secondId}/review`, manager, { decision: 'APPROVE' })).status, 200);
    const detail = await request(`/dashboard/tasks/${task.id}`, manager);
    assert.equal(detail.body.data.status, 'COMPLETED');
    assert.equal(detail.body.data.submissions.length, 2);
    const original = detail.body.data.submissions.find((item) => item.id === submissionId);
    assert.equal(original.evidence[0].record.notes, 'Đã kiểm tra');
    assert.equal(original.reason, 'Bổ sung ghi chú');
    assert.equal((await request(`/dashboard/tasks/${task.id}`, manager, undefined, 'DELETE')).status, 409);
});

test('invalid evidence rolls back state and cannot bypass review', { skip: !enabled }, async () => {
    const task = await createTask();
    const wrongActor = await createGrowth(other);
    const wrongBatch = await createGrowth(staff, secondBatch.id);
    assert.equal((await request(`/cultivation-batches/${batch.id}/growth-progress/${wrongActor.id}`, staff, { notes: 'Cannot claim another author' }, 'PATCH')).status, 403);
    const legacy = await prisma.growthProgressRecord.create({ data: { batchId: batch.id, stage: 'FRUITING', notes: 'Old unknown author' } });
    for (const evidence of [[], [{ type: 'GROWTH_PROGRESS', recordId: wrongActor.id }], [{ type: 'GROWTH_PROGRESS', recordId: wrongBatch.id }], [{ type: 'GROWTH_PROGRESS', recordId: legacy.id }], [{ type: 'FAKE', recordId: 1 }], [{ type: '__proto__', recordId: 1 }], [{ type: 'constructor', recordId: 1 }]]) {
        assert.equal((await request(`/dashboard/tasks/${task.id}/submissions`, staff, { evidence })).status, 400);
        assert.equal((await prisma.task.findUnique({ where: { id: task.id } })).status, 'TODO');
    }
    assert.equal((await request(`/dashboard/tasks/${task.id}`, manager, { status: 'COMPLETED' }, 'PATCH')).status, 400);
    assert.equal((await request(`/dashboard/tasks/${task.id}/submissions`, other, { evidence: [{ type: 'GROWTH_PROGRESS', recordId: wrongActor.id }] })).status, 403);
    assert.equal((await request(`/cultivation-batches/${batch.id}`, staff, { tasks: { create: { title: 'Bypass', status: 'COMPLETED' } } }, 'PUT')).status, 400);
});

test('concurrent submissions and reviews accept one request; self review forbidden', { skip: !enabled }, async () => {
    const task = await createTask();
    const record = await createGrowth();
    const results = await Promise.all([1, 2].map(() => request(`/dashboard/tasks/${task.id}/submissions`, staff, { evidence: [{ type: 'GROWTH_PROGRESS', recordId: record.id }] })));
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    const submissionId = results.find((result) => result.status === 201).body.data.id;
    const reviews = await Promise.all([1, 2].map(() => request(`/dashboard/tasks/${task.id}/submissions/${submissionId}/review`, manager, { decision: 'APPROVE' })));
    assert.deepEqual(reviews.map((result) => result.status).sort(), [200, 409]);
    const managerTask = await createTask(manager);
    const ownRecord = await createGrowth(manager);
    const ownSubmission = await request(`/dashboard/tasks/${managerTask.id}/submissions`, manager, { evidence: [{ type: 'GROWTH_PROGRESS', recordId: ownRecord.id }] });
    assert.equal(ownSubmission.status, 201);
    assert.equal((await request(`/dashboard/tasks/${managerTask.id}/submissions/${ownSubmission.body.data.id}/review`, manager, { decision: 'APPROVE' })).status, 403);
    assert.equal((await request(`/dashboard/tasks/${managerTask.id}`, manager, { status: 'CANCELLED' }, 'PATCH')).status, 200);
    assert.equal((await prisma.taskSubmission.findUnique({ where: { id: ownSubmission.body.data.id } })).status, 'CANCELLED');
    assert.equal((await request(`/dashboard/tasks/${managerTask.id}`, manager, { status: 'IN_PROGRESS' }, 'PATCH')).status, 200);
});

test('financial CRUD uses precise money, permissions and batch ownership', { skip: !enabled }, async () => {
    const expenseBody = { name: 'Phân bón', category: 'FERTILIZER', quantity: '2.500', unit: 'kg', unitPrice: '10.25', incurredAt: '2026-10-03T00:00:00Z' };
    assert.equal((await request(`/cultivation-batches/${batch.id}/expenses`, staff, expenseBody)).status, 403);
    let result = await request(`/cultivation-batches/${batch.id}/expenses`, manager, expenseBody);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const expenseId = result.body.data.id;
    assert.equal(result.body.data.amount, '25.63');
    for (const invalid of [{ unitPrice: '-1' }, { quantity: false }, { unitPrice: '1.234' }, { unitPrice: '9999999999999999.99', quantity: '999999999.999' }, { amount: '1' }]) {
        assert.equal((await request(`/cultivation-batches/${batch.id}/expenses`, manager, { ...expenseBody, ...invalid })).status, 400);
    }
    result = await request(`/cultivation-batches/${batch.id}/expenses/${expenseId}`, manager, { quantity: '3' }, 'PATCH');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.amount, '30.75');
    assert.equal((await request(`/cultivation-batches/${secondBatch.id}/expenses/${expenseId}`, manager, { quantity: '1' }, 'PATCH')).status, 404);
    assert.equal((await request(`/cultivation-batches/${batch.id}/financial-summary`, staff)).status, 403);
    result = await request(`/cultivation-batches/${batch.id}/sales`, manager, { quantityKg: '1.25', unitPrice: '50.10', soldAt: '2026-10-03T00:00:00Z', buyer: 'Khách A' });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.amount, '62.63');
    const saleId = result.body.data.id;
    result = await request(`/cultivation-batches/${batch.id}/financial-summary`);
    assert.equal(result.body.data.profit, '31.88');
    assert.equal(result.body.data.costPerHarvestKg, null);
    assert.equal(result.body.data.costsByCategory.FERTILIZER, '30.75');
    assert.equal((await request(`/cultivation-batches/${batch.id}/sales/${saleId}`, manager, { unitPrice: '60' }, 'PATCH')).status, 200);
    assert.equal((await request(`/cultivation-batches/${secondBatch.id}/sales/${saleId}`, manager, undefined, 'DELETE')).status, 404);
    assert.equal((await request(`/cultivation-batches/${batch.id}/sales/${saleId}`, manager, undefined, 'DELETE')).status, 200);
    result = await request(`/cultivation-batches/${batch.id}/financial-summary`);
    assert.equal(result.body.data.profit, '-30.75');
    assert.equal(result.body.data.profitMarginPercent, null);
    await request(`/cultivation-batches/${batch.id}/expenses/${expenseId}`, manager, undefined, 'DELETE');
});

test('harvest finalization accumulates yield; financial report uses event dates', { skip: !enabled }, async () => {
    assert.equal((await request(`/cultivation-batches/${batch.id}/harvests`, staff, { totalYieldKg: 10 })).status, 201);
    assert.equal((await request(`/cultivation-batches/${batch.id}/harvests`, staff, { totalYieldKg: 15, finalizeBatch: true })).status, 201);
    assert.equal((await prisma.cultivationBatch.findUnique({ where: { id: batch.id } })).actualYieldKg, 25);
    const harvests = await Promise.all([1, 2].map(() => request(`/cultivation-batches/${secondBatch.id}/harvests`, staff, { totalYieldKg: 5, finalizeBatch: true })));
    assert.ok(harvests.every((result) => result.status === 201));
    assert.equal((await prisma.cultivationBatch.findUnique({ where: { id: secondBatch.id } })).actualYieldKg, 10);
    assert.equal((await request(`/cultivation-batches/${batch.id}/sales`, manager, { quantityKg: '2', unitPrice: '100', soldAt: '2026-10-02T18:00:00Z' })).status, 201);
    const response = await request('/reports/financial?from=2026-10-03&to=2026-10-03&groupBy=day');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.summary.revenue, '200.00');
    assert.equal(response.body.series[0].period, '2026-10-03');
    assert.ok(response.body.data.some((row) => row.batchCode === 'TEST-001' && row.revenue === '200.00'));
    assert.equal((await request('/reports/financial', staff)).status, 403);
    for (const [format, signature] of [['csv', null], ['xlsx', 'PK'], ['pdf', '%PDF']]) {
        const result = await request(`/reports/financial/export?from=2026-10-03&to=2026-10-03&format=${format}`);
        assert.equal(result.status, 200);
        if (signature) assert.equal(result.body.subarray(0, signature.length).toString(), signature);
        else assert.match(result.body.toString(), /TEST-001/);
    }
});

test('three galleries manage covers, permissions, files and legacy fallback', { skip: !enabled }, async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNUWODAwMDAxAAGAAwKAQTFBdYUAAAAAElFTkSuQmCC', 'base64');
    for (const [resource, parentId] of [['production-facilities', facility.id], ['mushroom-species', species.id], ['cultivation-batches', batch.id]]) {
        const galleryPath = `/${resource}/${parentId}/images`;
        const form = new FormData();
        form.append('images', new Blob([png], { type: 'image/png' }), 'a.png');
        form.append('images', new Blob([png], { type: 'image/png' }), 'b.png');
        assert.equal((await request(galleryPath, staff, form)).status, 403);
        let result = await request(galleryPath, manager, form);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        const [first, second] = result.body.data;
        result.body.data.forEach((image) => uploadedUrls.add(image.imageUrl));
        assert.equal(first.isCover, true);
        assert.equal(second.isCover, false);
        assert.equal(first.isPublic, false);
        assert.equal(second.isPublic, false);
        assert.equal((await request(galleryPath, staff)).body.data.length, 2);
        const anonymous = await request(galleryPath, null);
        assert.deepEqual(anonymous.body.data, []);
        assert.equal(anonymous.body.pagination.totalItems, 0);
        const fileUrl = `${baseUrl.replace(/\/api$/, '')}${first.imageUrl}`;
        assert.equal((await fetch(fileUrl)).status, 404);
        assert.equal((await fetch(fileUrl, { headers: { authorization: `Bearer ${token(staff)}` } })).status, 200);
        assert.equal((await request(`${galleryPath}/${second.id}`, staff, { isCover: true }, 'PATCH')).status, 403);
        assert.equal((await request(`${galleryPath}/${second.id}`, manager, { isCover: true, isPublic: true, caption: 'Ảnh bìa mới' }, 'PATCH')).status, 200);
        const published = await request(galleryPath, null);
        assert.equal(published.body.pagination.totalItems, 1);
        assert.deepEqual(published.body.data, [{ id: second.id, imageUrl: second.imageUrl, caption: 'Ảnh bìa mới', isCover: true }]);
        assert.equal((await fetch(`${baseUrl.replace(/\/api$/, '')}${second.imageUrl}`)).status, 200);
        if (resource === 'mushroom-species') {
            const publicDetail = (await request(`/${resource}/${parentId}`, null)).body.data;
            assert.equal(publicDetail.coverImageUrl, second.imageUrl);
            assert.equal(publicDetail.imageCount, 1);
        }
        const detail = await request(`/${resource}/${parentId}`, staff);
        assert.equal(detail.body.data.coverImageUrl, second.imageUrl);
        assert.equal(detail.body.data.imageCount, 2);
        const concurrent = await Promise.all([first.id, second.id].map((imageId) => request(`${galleryPath}/${imageId}`, manager, { isCover: true }, 'PATCH')));
        assert.ok(concurrent.every((entry) => entry.status === 200));
        const gallery = await request(galleryPath);
        assert.equal(gallery.body.data.filter((image) => image.isCover).length, 1);
        const cover = gallery.body.data.find((image) => image.isCover);
        assert.equal((await request(`${galleryPath}/${cover.id}`, manager, undefined, 'DELETE')).status, 200);
        assert.equal(fs.existsSync(path.join(__dirname, '..', cover.imageUrl.slice(1))), false);
        const remaining = (await request(galleryPath)).body.data[0];
        assert.equal(remaining.isCover, true);
        await request(`${galleryPath}/${remaining.id}`, manager, undefined, 'DELETE');
        const empty = await request(`/${resource}/${parentId}`);
        assert.equal(empty.body.data.coverImageUrl, resource === 'mushroom-species' ? 'https://example.test/legacy.jpg' : null);
        const invalid = new FormData();
        invalid.append('images', new Blob(['text'], { type: 'text/plain' }), 'invalid.txt');
        assert.equal((await request(galleryPath, manager, invalid)).status, 400);
        const tooMany = new FormData();
        for (let index = 0; index < 6; index++) tooMany.append('images', new Blob([png], { type: 'image/png' }), `${index}.png`);
        assert.equal((await request(galleryPath, manager, tooMany)).status, 400);
        const tooLarge = new FormData();
        tooLarge.append('images', new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'large.png');
        assert.equal((await request(galleryPath, manager, tooLarge)).status, 400);
    }
});

test('batch deletion retains submitted evidence photos and removes unused gallery files', { skip: !enabled }, async () => {
    const disposable = await prisma.cultivationBatch.create({ data: { batchCode: 'DELETE-MEDIA', facilityId: facility.id, mushroomId: species.id, startDate: new Date() } });
    await prisma.batchStaff.create({ data: { batchId: disposable.id, userId: staff.id } });
    const task = await createTask(staff, disposable.id);
    const form = new FormData();
    form.append('stage', 'FRUITING');
    form.append('notes', 'Có ảnh minh chứng');
    form.append('images', new Blob(['image fixture'], { type: 'image/png' }), 'proof.png');
    const growth = await request(`/cultivation-batches/${disposable.id}/growth-progress`, staff, form);
    assert.equal(growth.status, 201);
    const imageUrl = growth.body.data.images[0].imageUrl;
    uploadedUrls.add(imageUrl);
    assert.equal((await request(`/dashboard/tasks/${task.id}/submissions`, staff, { evidence: [{ type: 'GROWTH_PROGRESS', recordId: growth.body.data.id }] })).status, 201);
    const galleryForm = new FormData();
    galleryForm.append('images', new Blob(['fixture'], { type: 'image/png' }), 'gallery.png');
    const gallery = await request(`/cultivation-batches/${disposable.id}/images`, manager, galleryForm);
    assert.equal(gallery.status, 201);
    const galleryUrl = gallery.body.data[0].imageUrl;
    uploadedUrls.add(galleryUrl);
    assert.equal((await request(`/cultivation-batches/${disposable.id}`, manager, undefined, 'DELETE')).status, 200);
    assert.equal(fs.existsSync(path.join(__dirname, '..', imageUrl.slice(1))), true);
    assert.equal(fs.existsSync(path.join(__dirname, '..', galleryUrl.slice(1))), false);
    const detail = await request(`/dashboard/tasks/${task.id}`);
    assert.equal(detail.body.data.submissions[0].evidence[0].record.images[0].imageUrl, imageUrl);
});

test('new SQL defaults preserve accounts and seed counters from issued codes', { skip: !enabled }, async () => {
  assert.equal((await prisma.user.findUnique({ where: { username: 'legacy' } })).must_change_password, false);
  assert.equal((await prisma.batchCodeCounter.findUnique({ where: { facilityId_year: { facilityId: 12, year: 2026 } } })).lastNumber, 99);
});
test('concurrent automatic codes are unique, isolated, immutable and never reused', { skip: !enabled }, async () => {
  const data = { facilityId: facility.id, mushroomId: species.id, startDate: '2030-12-31T17:00:00Z', status: 'PREPARATION' };
  const created = await Promise.all(Array.from({ length: 12 }, () => request('/cultivation-batches', manager, data)));
  for (const row of created) assert.equal(row.status, 201, JSON.stringify(row.body));
  const codes = created.map(row => row.body.data.batchCode);
  assert.equal(new Set(codes).size, 12);
  assert.ok(codes.every(code => code.startsWith(`LO-CS${facility.id}-2031-`)));
  const ids = created.map(row => row.body.data.id);
  const last = created.find(row => row.body.data.batchCode.endsWith('-012')).body.data;
  assert.equal((await request(`/cultivation-batches/${last.id}`, manager, undefined, 'DELETE')).status, 200);
  const next = await request('/cultivation-batches', manager, data); assert.equal(next.body.data.batchCode, `LO-CS${facility.id}-2031-013`); ids.push(next.body.data.id);
  const anotherYear = await request('/cultivation-batches', manager, { ...data, startDate: '2032-01-01' }); assert.equal(anotherYear.body.data.batchCode, `LO-CS${facility.id}-2032-001`); ids.push(anotherYear.body.data.id);
  const anotherFacility = await request('/cultivation-batches', manager, { ...data, facilityId: 1 }); assert.equal(anotherFacility.body.data.batchCode, 'LO-CS1-2031-001'); ids.push(anotherFacility.body.data.id);
  const moved = await request(`/cultivation-batches/${ids[0]}`, manager, { facilityId: 1, startDate: '2032-01-01' }, 'PUT'); assert.equal(moved.body.data.batchCode, codes[0]);
  assert.equal((await request(`/cultivation-batches/by-code/${codes[0]}`, manager)).body.data.id, ids[0]);
  assert.equal((await request('/cultivation-batches', staff, data)).status, 403);
  await prisma.batchCodeCounter.upsert({ where: { facilityId_year: { facilityId: facility.id, year: 2033 } }, create: { facilityId: facility.id, year: 2033, lastNumber: 999 }, update: { lastNumber: 999 } });
  const overflow = await request('/cultivation-batches', manager, { ...data, startDate: '2033-01-01' }); assert.equal(overflow.body.data.batchCode, `LO-CS${facility.id}-2033-1000`); ids.push(overflow.body.data.id);
  for (const id of ids) await prisma.cultivationBatch.deleteMany({ where: { id } });
});

test('mandatory password change uses real database updates and revokes the old JWT', { skip: !enabled }, async () => {
  const user = await prisma.user.create({ data: { username: 'password-integration', password_hash: 'temporary', full_name: 'Password test', email: '', phone_number: '', role_id: staff.role_id, tokenver: 0, must_change_password: true } });
  const me = await request('/auth/me', user); assert.equal(me.body.data.must_change_password, true);
  assert.equal((await request('/cultivation-batches', user)).body.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await request('/auth/change-password', user, { current_password: 'wrong', new_password: 'new-password' })).status, 400);
  const changed = await request('/auth/change-password', user, { current_password: 'temporary', new_password: 'new-password' });
  assert.equal(changed.status, 200); assert.equal(changed.body.data.must_change_password, false);
  assert.equal((await request('/auth/me', user)).status, 401);
  const fresh = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${changed.body.token}` } }); assert.equal(fresh.status, 200);
  const stored = await prisma.user.findUnique({ where: { id: user.id } }); assert.equal(stored.tokenver, 1); assert.equal(await require('bcrypt').compare('new-password', stored.password_hash), true);
  await prisma.user.delete({ where: { id: user.id } });
});


test('staff scope, care photos, notification ownership and immediate revocation', { skip: !enabled }, async () => {
    const facilityRow = await prisma.productionFacility.create({ data: { name: 'Restricted facility', address: 'Test', facilityType: 'HOUSEHOLD' } });
    const target = await prisma.cultivationBatch.create({ data: { batchCode: 'ACL-CARE-TEST', facilityId: facilityRow.id, mushroomId: species.id, startDate: new Date() } });
    const staffPath = '/cultivation-batches/' + target.id;
    const facilityPath = '/production-facilities/' + facilityRow.id;
    assert.equal((await request(staffPath, staff)).status, 403);
    assert.equal((await request(staffPath + '/staff', manager, { userId: staff.id })).status, 403);
    assert.equal((await request(staffPath + '/staff', admin, { userId: staff.id })).status, 400);
    assert.equal((await request(facilityPath + '/staff', admin, { userId: staff.id })).status, 201);
    assert.equal((await request(staffPath, staff)).status, 403);
    assert.equal((await request(staffPath + '/staff', admin, { userId: staff.id })).status, 201);
    assert.equal((await request(staffPath, staff)).status, 200);
    assert.equal((await request(staffPath, other)).status, 403);
    assert.equal((await request(staffPath, staff, { notes: 'No structural edit' }, 'PUT')).status, 400);
    assert.equal((await request(staffPath, staff, { status: 'FRUITING' }, 'PUT')).status, 200);
    const longAction = await request(staffPath + '/care-logs', staff, { actionType: 'a'.repeat(255), notes: 'Long custom action' });
    assert.equal(longAction.status, 201, JSON.stringify(longAction.body));
    assert.equal((await request(staffPath + '/care-logs', staff, { actionType: 'a'.repeat(256), notes: 'Too long' })).status, 400);
    const beforeFiles = fs.readdirSync(path.join(__dirname, '..', 'uploads', 'care-logs')).sort();
    const invalidForm = new FormData(); invalidForm.append('actionType', 'WATERING'); invalidForm.append('notes', 'Invalid type');
    invalidForm.append('images', new Blob(['not-image'], { type: 'text/plain' }), 'invalid.txt');
    assert.equal((await request(staffPath + '/care-logs', staff, invalidForm)).status, 400);
    const rollbackForm = new FormData(); rollbackForm.append('actionType', 'WATERING'); rollbackForm.append('images', new Blob(['image'], { type: 'image/png' }), 'rollback.png');
    assert.equal((await request(staffPath + '/care-logs', staff, rollbackForm)).status, 400);
    const excessive = new FormData(); excessive.append('actionType', 'WATERING'); excessive.append('notes', 'Too many');
    for (let i = 0; i < 6; i++) excessive.append('images', new Blob(['image'], { type: 'image/png' }), 'limit' + i + '.png');
    assert.equal((await request(staffPath + '/care-logs', staff, excessive)).status, 400);
    assert.deepEqual(fs.readdirSync(path.join(__dirname, '..', 'uploads', 'care-logs')).sort(), beforeFiles);
    const work = await createTask(staff, target.id);
    const foreign = await createTask(other, batch.id);
    let list = await request('/dashboard/tasks?status=ALL&assigneeUserId=' + other.id, staff);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.every((task) => task.assigneeUserId === staff.id));
    assert.equal((await request('/dashboard/tasks/' + foreign.id, staff)).status, 403);
    const form = new FormData();
    form.append('actionType', 'WATERING'); form.append('notes', 'Photo proof');
    form.append('images', new Blob(['care photo'], { type: 'image/png' }), 'care.png');
    const care = await request(staffPath + '/care-logs', staff, form);
    assert.equal(care.status, 201, JSON.stringify(care.body));
    assert.equal(care.body.data.images.length, 1);
    const url = care.body.data.images[0].imageUrl; uploadedUrls.add(url);
    assert.equal((await request(url.replace('/uploads', '/../uploads'), staff)).status, 200);
    assert.equal((await request(url.replace('/uploads', '/../uploads'), other)).status, 403);
    assert.equal((await request(url.replace('/uploads', '/../uploads'), null)).status, 404);
    const submitted = await request('/dashboard/tasks/' + work.id + '/submissions', staff, { evidence: [{ type: 'CARE_LOG', recordId: care.body.data.id }] });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.equal(submitted.body.data.evidence[0].record.images[0].imageUrl, url);
    assert.equal(await prisma.taskSubmissionImage.count({ where: { imageUrl: url } }), 1);
    const notice = await prisma.notification.findFirst({ where: { userId: staff.id, taskId: work.id, type: 'TASK_CREATED' } });
    assert.ok(notice);
    assert.equal((await request('/notifications/' + notice.id + '/read', other, {}, 'PATCH')).status, 404);
    assert.equal((await request('/notifications/' + notice.id + '/read', staff, {}, 'PATCH')).status, 200);
    assert.ok((await prisma.notification.findUnique({ where: { id: notice.id } })).readAt);
    assert.equal((await request(facilityPath + '/staff/' + staff.id, admin, undefined, 'DELETE')).status, 200);
    assert.equal(await prisma.batchStaff.count({ where: { userId: staff.id, batchId: target.id } }), 0);
    assert.equal((await request(staffPath, staff)).status, 403);
    assert.equal((await request('/dashboard/tasks/' + work.id, staff)).status, 403);
    list = await request('/dashboard/tasks?status=ALL&batchId=' + target.id, staff);
    assert.deepEqual(list.body.data, []);
    assert.equal((await prisma.task.findUnique({ where: { id: work.id } })).status, 'PENDING_REVIEW');
    assert.equal((await request('/dashboard/tasks/' + work.id, manager, { status: 'CANCELLED' }, 'PATCH')).status, 200);
    assert.equal((await request(staffPath + '/care-logs', staff, { actionType: 'WATERING', notes: 'Denied after revoke' })).status, 403);
});

test('push device rebinding cancels history and old unregister cannot remove the new session', { skip: !enabled }, async () => {
    const deviceToken = 'a'.repeat(64);
    const body = { token: deviceToken, platform: 'ios', provider: 'fcm' };
    const first = await request('/notifications/devices', staff, body, 'PUT'); assert.equal(first.status, 200);
    const device = await prisma.pushDevice.findFirst({ where: { token: deviceToken } });
    const notice = await prisma.notification.create({ data: { userId: staff.id, eventKey: 'device-test', type: 'TASK_UPDATED', title: 'Device test' } });
    await prisma.pushDelivery.create({ data: { notificationId: notice.id, deviceId: device.id } });
    const second = await request('/notifications/devices', other, body, 'PUT'); assert.equal(second.status, 200);
    assert.notEqual(second.body.data.registrationId, first.body.data.registrationId);
    assert.equal(await prisma.pushDelivery.count({ where: { deviceId: device.id, cancelledAt: { not: null } } }), 1);
    await request('/notifications/devices', staff, { token: deviceToken, registrationId: first.body.data.registrationId }, 'DELETE');
    assert.equal((await prisma.pushDevice.findUnique({ where: { id: device.id } })).active, true);
    await request('/notifications/devices', other, { token: deviceToken, registrationId: second.body.data.registrationId }, 'DELETE');
    assert.equal((await prisma.pushDevice.findUnique({ where: { id: device.id } })).active, false);
    assert.equal(await prisma.pushDelivery.count({ where: { deviceId: device.id } }), 1);
    assert.equal((await request('/notifications/push-config', staff)).status, 200);
    assert.equal((await request('/notifications/devices', staff, { token: 'retired', platform: 'android', provider: 'unifiedpush' }, 'PUT')).status, 400);
});

test('multiple FCM devices stay independent; worker cancellation uses the real registration guard', { skip: !enabled }, async () => {
    const value = 'b'.repeat(64);
    const body = { platform: 'android', provider: 'fcm', token: value };
    const iosToken = 'c'.repeat(64);
    const one = await request('/notifications/devices', staff, body, 'PUT');
    assert.equal(one.status, 200);
    const same = await request('/notifications/devices', staff, body, 'PUT');
    assert.equal(same.body.data.registrationId, one.body.data.registrationId);
    const production = await request('/notifications/devices', staff, { ...body, platform:'ios',token:iosToken }, 'PUT');
    assert.equal(production.status, 200);
    const devices = await prisma.pushDevice.findMany({ where: { userId: staff.id, active: true, token: {in:[value,iosToken]} } });
    assert.equal(devices.length, 2); assert.notEqual(devices[0].identityHash, devices[1].identityHash);
    const notices = await prisma.$transaction(tx => require('../services/notifications').notifyUsers(tx, { recipients: [staff.id], actorId: manager.id, eventKey: 'multi-device-notice', type: 'TASK_UPDATED', title: 'Generic' }));
    const deliveries = await prisma.pushDelivery.findMany({ where: { notificationId: notices[0].id, deviceId: { in: devices.map(d => d.id) } }, include: { device: true } });
    assert.equal(deliveries.length, 2);
    const sandbox = deliveries.find(d => d.device.platform === 'android');
    const live = deliveries.find(d => d.device.platform === 'ios');
    const { createPushProcessor } = require('../queues/notificationQueue');
    await createPushProcessor({ prisma, senders: { fcm: async () => {
        const rebound = await request('/notifications/devices', other, body, 'PUT'); assert.equal(rebound.status, 200);
        throw { kind: 'invalid' };
    } } })({ data: { deliveryId: sandbox.id } });
    const rebound = await prisma.pushDevice.findUnique({ where: { id: sandbox.deviceId } });
    assert.equal(rebound.active, true); assert.equal(rebound.userId, other.id);
    let sends = 0;
    const processor = createPushProcessor({ prisma, senders: { fcm: async () => { sends++; } } });
    await processor({ data: { deliveryId: live.id } }); await processor({ data: { deliveryId: live.id } });
    assert.equal(sends, 1); assert.ok((await prisma.pushDelivery.findUnique({ where: { id: live.id } })).sentAt);
    assert.equal((await prisma.pushDevice.findUnique({ where: { id: live.deviceId } })).active, true);
});

test('changing push server origin creates a new registration and cancels pending deliveries', {skip:!enabled}, async () => {
    const body={platform:'android',provider:'fcm',token:'origin-test-token',serverOrigin:'https://first.example.test'};
    const first=await request('/notifications/devices',staff,body,'PUT');assert.equal(first.status,200);
    assert.equal(first.body.data.serverOrigin,body.serverOrigin);
    const same=await request('/notifications/devices',staff,body,'PUT');assert.equal(same.body.data.registrationId,first.body.data.registrationId);
    const device=await prisma.pushDevice.findFirst({where:{token:body.token}});
    const notice=await prisma.notification.create({data:{userId:staff.id,eventKey:'origin-change-test',type:'LOCAL_TEST',title:'Test'}});
    const delivery=await prisma.pushDelivery.create({data:{notificationId:notice.id,deviceId:device.id}});
    const next=await request('/notifications/devices',staff,{...body,serverOrigin:'https://second.example.test'},'PUT');assert.equal(next.status,200);
    assert.notEqual(next.body.data.registrationId,first.body.data.registrationId);
    assert.ok((await prisma.pushDelivery.findUnique({where:{id:delivery.id}})).cancelledAt);
    await request('/notifications/devices',staff,{token:body.token,registrationId:first.body.data.registrationId},'DELETE');
    assert.equal((await prisma.pushDevice.findUnique({where:{id:device.id}})).active,true);
    const current=await prisma.notification.create({data:{userId:staff.id,eventKey:'origin-send-test',type:'LOCAL_TEST',title:'Test'}});
    const row=await prisma.pushDelivery.create({data:{notificationId:current.id,deviceId:device.id}});
    let payload;
    await require('../queues/notificationQueue').createPushProcessor({prisma,config:{apiUrl:'https://fallback.example.test'},senders:{fcm:async(d,p)=>payload=p}})({data:{deliveryId:row.id}});
    assert.equal(payload.origin,'https://second.example.test');
    assert.equal((await request('/notifications/devices',staff,{...body,serverOrigin:'https://user:pass@example.test'},'PUT')).status,400);
});

async function bulkFixture(prefix) {
    const target = await prisma.productionFacility.create({ data: { name: prefix, address: 'Test', facilityType: 'HOUSEHOLD' } });
    const users = [];
    for (const suffix of ['a','b','c']) users.push(await prisma.user.create({ data: { username: `${prefix}-${suffix}`, full_name: `${prefix} ${suffix}`, password_hash: 'unused', phone_number: '', email: '', role_id: staff.role_id, tokenver: 0 } }));
    const targetBatch = await prisma.cultivationBatch.create({ data: { batchCode: prefix, facilityId: target.id, mushroomId: species.id, startDate: new Date() } });
    return { target, users, targetBatch, path: `/production-facilities/${target.id}/staff`, batchPath: `/cultivation-batches/${targetBatch.id}/staff` };
}
test('staff candidates exclude assignments before search/pagination; bulk grants preserve the legacy API', {skip:!enabled}, async () => {
    const f=await bulkFixture('bulk-candidates');
    const first=await request(f.path,admin,{userId:f.users[0].id});assert.equal(first.status,201);assert.equal(first.body.data.userId,f.users[0].id);assert.equal(Array.isArray(first.body.data),false);
    const list=await request(f.path+'?available=true&search=bulk-candidates&limit=1',admin);
    assert.equal(list.status,200);assert.equal(list.body.pagination.totalItems,2);assert.equal(list.body.pagination.totalPages,2);assert.equal(list.body.data[0].id,f.users[1].id);
    assert.deepEqual(Object.keys(list.body.data[0]).sort(),['full_name','id','username']);
    const page2=await request(f.path+'?available=true&search=bulk-candidates&limit=1&page=2',admin);assert.equal(page2.body.data[0].id,f.users[2].id);
    const bulk=await request(f.path,admin,{userIds:[f.users[0].id,f.users[1].id,String(f.users[1].id),f.users[2].id]});
    assert.equal(bulk.status,201);assert.equal(bulk.body.addedCount,2);assert.equal(bulk.body.data.length,3);
    assert.equal(await prisma.facilityStaff.count({where:{facilityId:f.target.id}}),3);
    const notices=await prisma.notification.count({where:{userId:{in:f.users.map(u=>u.id)},type:'PERMISSION_GRANTED'}});assert.equal(notices,3);
    const again=await request(f.path,admin,{userIds:f.users.map(u=>u.id)});assert.equal(again.body.addedCount,0);
    assert.equal(await prisma.notification.count({where:{userId:{in:f.users.map(u=>u.id)},type:'PERMISSION_GRANTED'}}),notices);
    assert.deepEqual((await request(f.path+'?available=true&search=bulk-candidates',admin)).body.data,[]);
    assert.equal((await request(f.path+'?available=false',admin)).body.data.length,3);
    await request(f.path+'/'+f.users[1].id,admin,undefined,'DELETE');
    const available=await request(f.path+'?available=true&search=bulk-candidates',admin);assert.deepEqual(available.body.data.map(u=>u.id),[f.users[1].id]);
    for(const actor of [manager,staff]) { assert.equal((await request(f.path+'?available=true',actor)).status,403);assert.equal((await request(f.path,actor,{userIds:[f.users[1].id]})).status,403); }
    assert.equal((await request(f.path+'?available=maybe',admin)).status,400);
});
test('bulk batch assignment rolls back the whole group if membership or staff role changes', {skip:!enabled}, async () => {
    const f=await bulkFixture('bulk-atomic');
    const ids=f.users.map(u=>u.id);
    await request(f.path,admin,{userIds:ids.slice(0,2)});
    let candidates=await request(f.batchPath+'?available=true&search=bulk-atomic',admin);assert.deepEqual(candidates.body.data.map(u=>u.id),ids.slice(0,2));
    await request(f.path+'/'+ids[1],admin,undefined,'DELETE');
    let result=await request(f.batchPath,admin,{userIds:ids.slice(0,2)});assert.equal(result.status,400);assert.equal(result.body.code,'ASSIGNMENT_INELIGIBLE');assert.match(result.body.message,/bulk-atomic b/);
    assert.equal(await prisma.batchStaff.count({where:{batchId:f.targetBatch.id}}),0);
    assert.equal(await prisma.notification.count({where:{batchId:f.targetBatch.id,type:'PERMISSION_GRANTED'}}),0);
    await request(f.path,admin,{userId:ids[1]});
    await prisma.user.update({where:{id:ids[1]},data:{role_id:manager.role_id}});
    result=await request(f.batchPath,admin,{userIds:ids.slice(0,2)});assert.equal(result.status,400);assert.match(result.body.message,/bulk-atomic b/);
    assert.equal(await prisma.batchStaff.count({where:{batchId:f.targetBatch.id}}),0);
    await prisma.user.update({where:{id:ids[1]},data:{role_id:staff.role_id}});
    result=await request(f.batchPath,admin,{userIds:ids.slice(0,2)});assert.equal(result.status,201);assert.equal(result.body.addedCount,2);
    assert.deepEqual((await request(f.batchPath+'?available=true&search=bulk-atomic',admin)).body.data,[]);
    await request(f.batchPath+'/'+ids[0],admin,undefined,'DELETE');
    assert.deepEqual((await request(f.batchPath+'?available=true&search=bulk-atomic',admin)).body.data.map(u=>u.id),[ids[0]]);
    for(const body of [{userIds:[]},{userIds:Array(101).fill(ids[0])},{userIds:[ids[0],false]},{userIds:[ids[0]],userId:ids[1]},{userIds:[ids[0],manager.id]},{userIds:[ids[0],999999999]}]) assert.equal((await request(f.batchPath,admin,body)).status,400);
    assert.equal(await prisma.batchStaff.count({where:{batchId:f.targetBatch.id}}),1);
});
test('two admins adding overlapping staff groups create one assignment and notification per person', {skip:!enabled}, async () => {
    const f=await bulkFixture('bulk-concurrent');
    const secondAdmin=await prisma.user.create({data:{username:'bulk-second-admin',full_name:'Other admin',password_hash:'unused',phone_number:'',email:'',role_id:admin.role_id,tokenver:0}});
    const result=await Promise.all([request(f.path,admin,{userIds:f.users.map(u=>u.id)}),request(f.path,secondAdmin,{userIds:f.users.map(u=>u.id)})]);
    assert.deepEqual(result.map(r=>r.status),[201,201]);assert.deepEqual(result.map(r=>r.body.addedCount).sort(),[0,3]);
    assert.equal(await prisma.facilityStaff.count({where:{facilityId:f.target.id}}),3);
    assert.equal(await prisma.notification.count({where:{userId:{in:f.users.map(u=>u.id)},type:'PERMISSION_GRANTED'}}),3);
    await request(f.path,admin,{userIds:f.users.map(u=>u.id)});
    const batchResult=await Promise.all([request(f.batchPath,admin,{userIds:f.users.map(u=>u.id)}),request(f.batchPath,secondAdmin,{userIds:f.users.map(u=>u.id)})]);
    assert.deepEqual(batchResult.map(r=>r.status),[201,201]);assert.deepEqual(batchResult.map(r=>r.body.addedCount).sort(),[0,3]);
    assert.equal(await prisma.batchStaff.count({where:{batchId:f.targetBatch.id}}),3);
    assert.equal(await prisma.notification.count({where:{batchId:f.targetBatch.id,type:'PERMISSION_GRANTED'}}),3);
});
