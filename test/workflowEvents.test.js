const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const { configureWorkflowSocket, refreshUsers } = require('../services/workflowEvents');
const { emitLookupEvent } = require('../services/classifierLifecycle');
process.env.JWT_SECRET = 'workflow-socket-test';
global.allRoles = ['admin', 'manager', 'staff'];
const users = [{ id: 1, username: 'staff', tokenver: 0, role: { name: 'staff' } }, { id: 2, username: 'other', tokenver: 0, role: { name: 'staff' } }];
global.prisma = { user: { findUnique: async ({ where }) => users.find((user) => user.id === where.id) || null }, cultivationBatch: { findFirst: async ({ where }) => where.id === 10 ? { id: 10 } : null } };
let server, io, origin;
const clients = [];
before(async () => { server = http.createServer(); io = new Server(server); global.io = io; configureWorkflowSocket(io); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port; });
after(async () => { for (const socket of clients) socket.disconnect(); await new Promise((resolve) => io.close(resolve)); delete global.io; });
const token = (user) => jwt.sign({ id: user.id, username: user.username, tokenver: user.tokenver }, process.env.JWT_SECRET);
async function client(user) {
    const socket = connect(origin + '/workflow', { transports: ['websocket'], auth: { token: token(user) }, forceNew: true });
    clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
}
test('workflow sockets authenticate, restrict delivery, and never send records', async () => {
    const first = await client(users[0]), other = await client(users[1]);
    const received = [], foreign = [];
    first.on('refresh', (data) => received.push(data)); other.on('refresh', (data) => foreign.push(data));
    first.emit('join', 'user_2');
    await refreshUsers([1], 'tasks', 'work-id');
    await refreshUsers([1], 'care-logs', 99);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(received, [{ resource: 'tasks', id: 'work-id' }]); assert.deepEqual(foreign, []);
    users[0].tokenver++;
    const disconnected = new Promise((resolve) => first.once('disconnect', resolve));
    await refreshUsers([1], 'notifications'); await disconnected;
    assert.equal(received.length, 1);
});
test('invalid workflow token is rejected', async () => {
    const socket = connect(origin + '/workflow', { transports: ['websocket'], auth: { token: 'invalid' }, reconnection: false, forceNew: true }); clients.push(socket);
    const error = await new Promise((resolve) => socket.once('connect_error', resolve));
    assert.equal(error.message, 'AUTH_INVALID_TOKEN');
});
test('classifier events contain only the refresh resource and identifier', () => {
    const emitted = [];
    const previous = global.io;
    global.io = { to: (room) => ({ emit: (...args) => emitted.push({ room, args }) }) };
    try { emitLookupEvent('job-id', 'finished', { result: { private: 'result payload' }, status: 'SUCCEEDED' }); }
    finally { global.io = previous; }
    assert.deepEqual(emitted, [{ room: 'job_job-id', args: ['refresh', { resource: 'classifier-job', id: 'job-id' }] }]);
});

