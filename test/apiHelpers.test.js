const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const { fail, id, pagination, pageResponse, fields, textField, numberField, dateField, handle, errorHandler } = require('../services/apiHelpers');

const invalid = (callback) => assert.throws(callback, { status: 400 });

test('numeric IDs reject partial parsing, coercion and unsafe integers', () => {
    assert.equal(id('0012'), 12);
    assert.equal(id(12), 12);
    for (const value of ['12abc', '1.5', '1e2', ' 12 ', '', '0', '-1', '9007199254740992', [], {}, null, true, NaN, Infinity]) invalid(() => id(value));
});

test('pagination preserves configurable defaults and rejects invalid pages and overflow', () => {
    assert.deepEqual(pagination({}), { page: 1, limit: 10, skip: 0 });
    assert.deepEqual(pagination({}, 100, 20), { page: 1, limit: 20, skip: 0 });
    assert.deepEqual(pagination({ page: '2', limit: '200' }, 100, 20), { page: 2, limit: 100, skip: 100 });
    for (const value of ['0', '-1', '2abc', '1.5', '', ['1', '2']]) {
        invalid(() => pagination({ page: value }));
        invalid(() => pagination({ limit: value }));
    }
    invalid(() => pagination({ page: String(Number.MAX_SAFE_INTEGER), limit: '50' }));
    assert.deepEqual(pageResponse([], 0, pagination({})), { data: [], pagination: { totalItems: 0, currentPage: 1, totalPages: 0, pageSize: 10 } });
});

test('body fields reject wrong shapes and unknown fields while allowing explicit image-only updates', () => {
    for (const body of [undefined, null, [], 'stage', {}, { batchId: 1 }]) invalid(() => fields(body, ['stage']));
    assert.doesNotThrow(() => fields({ stage: 'FRUITING' }, ['stage']));
    assert.doesNotThrow(() => fields({}, ['stage'], { allowEmpty: true }));
    invalid(() => fields([], ['stage'], { allowEmpty: true }));
    invalid(() => fields({ batchId: 1 }, ['stage'], { allowEmpty: true }));
    assert.equal(textField('  ghi chú  ', 'notes'), 'ghi chú');
    assert.equal(textField(null, 'notes', 500, true), null);
    invalid(() => textField('   ', 'stage'));
    invalid(() => textField('abcd', 'stage', 3));
});

test('number fields enforce finite values, ranges, safe integers and nullability', () => {
    assert.equal(numberField(' 12.5 ', 'yield', { min: 0 }), 12.5);
    assert.equal(numberField(0, 'yield', { min: 0 }), 0);
    assert.equal(numberField(null, 'yield', { nullable: true }), null);
    for (const value of [undefined, null, true, [], {}, '', ' ', '12kg', '1e2', '0x10', NaN, Infinity]) invalid(() => numberField(value, 'yield'));
    invalid(() => numberField(-1, 'yield', { min: 0 }));
    invalid(() => numberField(101, 'defectRate', { min: 0, max: 100 }));
    invalid(() => numberField(1.5, 'bags', { integer: true }));
    invalid(() => numberField(Number.MAX_SAFE_INTEGER + 1, 'bags', { integer: true }));
});

test('dates validate the calendar and timezone without normalizing invalid times', () => {
    assert.equal(dateField('2024-02-29', 'date').toISOString(), '2024-02-29T00:00:00.000Z');
    assert.equal(dateField('2026-10-01T09:30+07:00', 'date').toISOString(), '2026-10-01T02:30:00.000Z');
    assert.equal(dateField('2026-10-01T09:30:00.123Z', 'date').toISOString(), '2026-10-01T09:30:00.123Z');
    for (const value of ['2026-02-29', '2026-02-30T08:00:00Z', '2026-13-01', '2026-10-01T09:30:00', '2026-10-01T24:00:00Z', '2026-10-01T09:60:00Z', '10/01/2026', '', null, 0]) invalid(() => dateField(value, 'date'));
});

const response = () => ({
    headersSent: false,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
});

test('handle forwards next and serializes synchronous and asynchronous domain errors', async () => {
    const next = () => 'next-result';
    assert.equal(await handle((req, res, passedNext) => { assert.equal(passedNext, next); return passedNext(); })({}, response(), next), 'next-result');
    for (const [status, code] of [[400, 'INVALID_REQUEST'], [401, 'AUTH_INVALID_TOKEN'], [403, 'AUTH_FORBIDDEN'], [404, 'INVALID_REQUEST'], [409, 'STATE_CONFLICT'], [422, 'INVALID_REQUEST']]) {
        const res = response();
        await handle(async () => fail(status, 'Thông báo nghiệp vụ', code))({}, res, next);
        assert.equal(res.statusCode, status);
        assert.deepEqual(res.body, { code, message: 'Thông báo nghiệp vụ' });
    }
    const res = response();
    await handle(() => fail(400, 'Specific error', 'CUSTOM_ERROR_V2'))({}, res, next);
    assert.equal(res.body.code, 'CUSTOM_ERROR_V2');
});

test('Prisma conflicts and validation use public errors without exposing database details', () => {
    for (const code of ['P2002', 'P2003', 'P2025', 'P2034']) {
        const res = response();
        errorHandler(Object.assign(new Error('private database details'), { code }), {}, res, () => {});
        assert.equal(res.statusCode, 409);
        assert.deepEqual(res.body, { code: 'STATE_CONFLICT', message: 'Dữ liệu đã thay đổi; vui lòng tải lại' });
    }
    const res = response();
    errorHandler(Object.assign(new Error('private Prisma validation details'), { name: 'PrismaClientValidationError' }), {}, res, () => {});
    assert.deepEqual(res.body, { code: 'INVALID_REQUEST', message: 'Dữ liệu không hợp lệ' });
    assert.equal(res.statusCode, 400);
});

test('server errors hide internal messages and preserve an intentional 503 message', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    const res = response();
    const internal = new Error('private connection details');
    await handle(async () => { throw internal; })({}, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { code: 'INTERNAL_ERROR', message: 'Lỗi máy chủ' });
    assert.equal(logs[0][0], internal);
    const unavailable = response();
    await handle(() => fail(503, 'Không thể tiếp nhận yêu cầu phân loại'))({}, unavailable, () => {});
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.body, { code: 'INTERNAL_ERROR', message: 'Không thể tiếp nhận yêu cầu phân loại' });
});

test('errors after headers are sent reach next without writing another response', async () => {
    const error = new Error('stream failed');
    const res = { headersSent: true, status() { assert.fail('must not send headers again'); } };
    let forwarded;
    await handle(async () => { throw error; })({}, res, (value) => { forwarded = value; });
    assert.equal(forwarded, error);
});

const app = express();
app.use(express.json());
app.post('/parse', handle((req, res) => res.json({ data: req.body })));
app.use(errorHandler);
let server;
let baseUrl;
before(async () => {
    server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('the shared Express middleware returns JSON for malformed request bodies', async () => {
    const res = await fetch(`${baseUrl}/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"private":' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { code: 'INVALID_REQUEST', message: 'Dữ liệu không hợp lệ' });
});
