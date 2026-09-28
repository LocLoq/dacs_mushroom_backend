const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'reports-test-secret';
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
global.prisma = {
    user: { findUnique: async () => ({ id: 1, username: 'manager', tokenver: 0, role: { name: 'manager' } }) },
    cultivationBatch: {
        findMany: async () => [{
            batchCode: 'LO-001', status: 'FRUITING', startDate: new Date('2026-01-01'), expectedHarvestDate: null, endDate: null, defectRate: 2,
            facility: { name: 'Trại A', province: 'Lâm Đồng' }, mushroom: { commonName: 'Nấm sò', scientificName: 'Pleurotus ostreatus' },
            harvestRecords: [{ totalYieldKg: 12.5 }], growthRecords: [{ stage: 'FRUITING', recordedAt: new Date('2026-01-02') }]
        }]
    }
};

const router = require('../routes/reports');
const app = express();
app.use('/api/reports', router);
let server;
let baseUrl;
const token = jwt.sign({ id: 1, username: 'manager', role: 'manager', tokenver: 0 }, process.env.JWT_SECRET);

before(async () => {
    server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

const requestExport = (format) => fetch(`${baseUrl}/api/reports/cultivation/export?format=${format}`, { headers: { authorization: `Bearer ${token}` } });

test('report export returns CSV with BOM and attachment header', async () => {
    const response = await requestExport('csv');
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /\.csv/);
    assert.deepEqual([...body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.match(body.toString('utf8'), /LO-001/);
});

test('report export returns XLSX and PDF files', async () => {
    let response = await requestExport('xlsx');
    let body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.deepEqual([...body.subarray(0, 2)], [0x50, 0x4b]);

    response = await requestExport('pdf');
    body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(body.subarray(0, 4).toString(), '%PDF');
});
