const assert = require('node:assert/strict');
const { before, after, beforeEach, afterEach, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'gallery-visibility-test-secret';
global.allRoles = ['admin', 'manager', 'staff'];
global.privilegedRoles = ['admin', 'manager'];
const users = [
    { id: 1, username: 'manager', tokenver: 0, role: { name: 'manager' } },
    { id: 2, username: 'staff', tokenver: 0, role: { name: 'staff' } }
];
const resources = [
    ['production-facilities', 'productionFacility', 'facilityImage', 'facilityId'],
    ['mushroom-species', 'mushroom', 'mushroomImage', 'mushroomId'],
    ['cultivation-batches', 'cultivationBatch', 'batchImage', 'batchId']
];
const stores = {};
const files = new Set();
const galleryDirectory = path.join(__dirname, '..', 'uploads', 'gallery');
const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
const project = (row, select) => row && (select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])) : { ...row });
global.prisma = {
    user: { findUnique: async ({ where }) => users.find((user) => user.id === where.id) || null },
    taskSubmissionImage: { count: async () => 0 },
    $transaction: async (callback) => callback(global.prisma)
};
for (const [, parentModel, imageModel, parentField] of resources) {
    stores[imageModel] = [];
    const parent = ({ where, include } = {}) => {
        if (where?.id !== undefined && ![1, 2].includes(where.id)) return null;
        const row = { id: where?.id || 1 };
        if (include) {
            const all = stores[imageModel].filter((image) => image[parentField] === row.id);
            const visible = all.filter((image) => matches(image, include.images?.where));
            visible.sort((a, b) => Number(b.isCover) - Number(a.isCover) || a.id - b.id);
            row.images = visible.slice(0, 1);
            const countSelection = include._count?.select.images;
            row._count = { images: all.filter((image) => matches(image, typeof countSelection === 'object' ? countSelection.where : undefined)).length };
        }
        return row;
    };
    global.prisma[parentModel] = {
        findUnique: async (args) => parent(args),
        findMany: async (args) => [parent(args)],
        count: async () => 1,
        updateMany: async ({ where }) => ({ count: parent({ where }) ? 1 : 0 })
    };
    global.prisma[imageModel] = {
        count: async ({ where }) => stores[imageModel].filter((row) => matches(row, where)).length,
        findMany: async ({ where, skip, take, select }) => stores[imageModel].filter((row) => matches(row, where)).sort((a, b) => Number(b.isCover) - Number(a.isCover) || a.id - b.id).slice(skip, skip + take).map((row) => project(row, select)),
        findFirst: async ({ where, select }) => project(stores[imageModel].find((row) => matches(row, where)), select),
        create: async ({ data }) => {
            const row = { id: stores[imageModel].length + 1, createdAt: new Date(), ...data };
            stores[imageModel].push(row);
            files.add(path.join(__dirname, '..', row.imageUrl.slice(1)));
            return { ...row };
        },
        update: async ({ where, data }) => Object.assign(stores[imageModel].find((row) => matches(row, where)), data),
        updateMany: async ({ where, data }) => {
            stores[imageModel].filter((row) => matches(row, where)).forEach((row) => Object.assign(row, data));
            return { count: 1 };
        }
    };
}
const app = express();
app.use(express.json());
const { createGalleryRouter } = require('../routes/gallery');
for (const [resource, parentModel, imageModel, parentField] of resources) {
    app.use(`/api/${resource}`, resource === 'mushroom-species' ? require('../routes/mushroomSpeciesManagement') : createGalleryRouter(parentModel, imageModel, parentField));
}
app.use('/uploads', require('../middlewares/galleryMedia').galleryMediaAccess, express.static(path.join(__dirname, '..', 'uploads')));
let server;
let baseUrl;
const token = (user, options = {}) => jwt.sign({ id: user.id, username: user.username, tokenver: user.tokenver, ...options }, process.env.JWT_SECRET);
const request = async (url, { user, body, method = body === undefined ? 'GET' : 'POST', authorization } = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { ...(authorization ? { authorization } : user ? { authorization: `Bearer ${token(user)}` } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) })
    });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, body: data, headers: response.headers };
};
const form = (isPublic, count = 1) => {
    const body = new FormData();
    for (let index = 0; index < count; index++) body.append('images', new Blob(['gallery test image'], { type: 'image/png' }), `original-${index}.png`);
    body.append('caption', 'Gallery caption');
    if (isPublic !== undefined) body.append('isPublic', isPublic);
    return body;
};
before(async () => {
    server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => Object.values(stores).forEach((store) => { store.length = 0; }));
afterEach(async () => {
    await Promise.all([...files].map((file) => fs.promises.unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; })));
    files.clear();
});
after(async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

for (const [resource] of resources) {
    test(`${resource}: anonymous visibility, authenticated metadata, pagination and publishing`, async () => {
        const url = `/api/${resource}/1/images`;
        let result = await request(url, { user: users[0], body: form(undefined) });
        assert.equal(result.status, 201);
        const privateImage = result.body.data[0];
        assert.equal(privateImage.isPublic, false);
        result = await request(url, { user: users[0], body: form('true', 2) });
        assert.equal(result.status, 201);
        assert.ok(result.body.data.every((image) => image.isPublic));
        const publicImage = result.body.data[0];
        result = await request(`${url}?limit=1&page=2`);
        assert.equal(result.status, 200);
        assert.equal(result.body.data.length, 1);
        assert.deepEqual(Object.keys(result.body.data[0]).sort(), ['caption', 'id', 'imageUrl', 'isCover']);
        assert.deepEqual(result.body.pagination, { totalItems: 2, currentPage: 2, totalPages: 2, pageSize: 1 });
        assert.equal(result.headers.get('cache-control'), 'private, no-store');
        assert.match(result.headers.get('vary'), /Authorization/);
        result = await request(url, { user: users[1] });
        assert.equal(result.body.pagination.totalItems, 3);
        assert.equal(result.body.data[0].originalName, 'original-0.png');
        assert.equal(result.body.data[0].uploadedByUserId, users[0].id);
        assert.ok(result.body.data[0].createdAt);
        assert.equal(result.body.data[0].isPublic, false);
        assert.equal((await request(privateImage.imageUrl)).status, 404);
        assert.equal((await request(privateImage.imageUrl, { user: users[1] })).status, 200);
        assert.equal((await request(publicImage.imageUrl)).status, 200);
        assert.equal((await request(url, { authorization: 'Bearer invalid' })).status, 401);
        assert.equal((await request(url, { authorization: `Bearer ${token(users[0], { exp: 1 })}` })).status, 401);
        assert.equal((await request(url, { authorization: `Bearer ${token(users[0], { tokenver: 99 })}` })).status, 401);
        assert.equal((await request(`${url}/${privateImage.id}`, { user: users[1], body: { isPublic: true }, method: 'PATCH' })).status, 403);
        assert.equal((await request(`${url}/${privateImage.id}`, { body: { isPublic: true }, method: 'PATCH' })).status, 401);
        for (const invalid of ['false', null, 0]) {
            assert.equal((await request(`${url}/${privateImage.id}`, { user: users[0], body: { isPublic: invalid }, method: 'PATCH' })).status, 400);
        }
        assert.equal((await request(`${url}/${privateImage.id}`, { user: users[0], body: { isPublic: true }, method: 'PATCH' })).status, 200);
        assert.equal((await request(url)).body.pagination.totalItems, 3);
        assert.equal((await request(privateImage.imageUrl)).status, 200);
        assert.equal((await request(`${url}/${publicImage.id}`, { user: users[0], body: { isPublic: false }, method: 'PATCH' })).status, 200);
        assert.equal((await request(url)).body.pagination.totalItems, 2);
        assert.equal((await request(publicImage.imageUrl)).status, 404);
        assert.equal((await request(publicImage.imageUrl, { method: 'HEAD' })).status, 404);
        assert.equal((await request(`${url.replace('/1/', '/2/')}/${privateImage.id}`, { user: users[0], body: { isPublic: true }, method: 'PATCH' })).status, 404);
        assert.equal((await request(`/api/${resource}/999/images`)).status, 404);
    });
}

test('upload rejects invalid visibility and cleans files after validation failures', async () => {
    const before = new Set(fs.readdirSync(galleryDirectory));
    for (const invalid of ['1', 'yes', '', 'TRUE']) {
        const result = await request('/api/mushroom-species/1/images', { user: users[0], body: form(invalid) });
        assert.equal(result.status, 400);
    }
    const duplicate = form('true');
    duplicate.append('isPublic', 'false');
    assert.equal((await request('/api/mushroom-species/1/images', { user: users[0], body: duplicate })).status, 400);
    assert.deepEqual(new Set(fs.readdirSync(galleryDirectory)), before);
});

test('media privacy survives encoded URL aliases and conditional requests', async () => {
    const result = await request('/api/mushroom-species/1/images', { user: users[0], body: form('false') });
    const image = result.body.data[0];
    for (const alias of [image.imageUrl.replace('/gallery/', '/%67allery/'), image.imageUrl.replace('/gallery/', '/GALLERY/'), image.imageUrl.replace('/gallery/', '/gallery%2f'), image.imageUrl.replace('/gallery/', '/gallery./'), image.imageUrl.replace('/gallery/', '/gallery%20/'), image.imageUrl.replace('/gallery/', '/gallery%5c')]) {
        assert.equal((await request(alias)).status, 404, alias);
    }
    const authenticated = await request(image.imageUrl, { user: users[0] });
    assert.equal(authenticated.headers.get('cache-control'), 'private, no-store');
    assert.equal((await request(image.imageUrl, { authorization: 'Bearer invalid' })).status, 401);
    const conditional = await fetch(`${baseUrl}${image.imageUrl}`, { headers: { 'if-none-match': authenticated.headers.get('etag') } });
    assert.equal(conditional.status, 404);
});

test('public mushroom list/detail use public covers and counts while staff see private covers', async () => {
    const url = '/api/mushroom-species/1/images';
    const privateImage = (await request(url, { user: users[0], body: form('false') })).body.data[0];
    const publicImage = (await request(url, { user: users[0], body: form('true') })).body.data[0];
    for (const pathname of ['/api/mushroom-species', '/api/mushroom-species/1']) {
        let result = await request(pathname);
        const publicData = Array.isArray(result.body.data) ? result.body.data[0] : result.body.data;
        assert.equal(publicData.coverImageUrl, publicImage.imageUrl);
        assert.equal(publicData.imageCount, 1);
        result = await request(pathname, { user: users[1] });
        const staffData = Array.isArray(result.body.data) ? result.body.data[0] : result.body.data;
        assert.equal(staffData.coverImageUrl, privateImage.imageUrl);
        assert.equal(staffData.imageCount, 2);
        assert.equal((await request(pathname, { authorization: 'Bearer invalid' })).status, 401);
    }
});
