const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { test } = require('node:test');
const { createPythonSupervisor } = require('../services/pythonSupervisor');
const { classifierConfig } = require('../config/classifier.cjs');

const settle = () => new Promise((resolve) => setImmediate(resolve));
function child() {
    const process = new EventEmitter();
    process.kill = () => { process.emit('exit', null, 'SIGTERM'); return true; };
    return process;
}

test('Python restarts after unexpected exits with 2/4/8 second backoff, then stops at the budget', async () => {
    const children = [], delays = [], logs = [];
    const supervisor = createPythonSupervisor({ spawnChild: () => { const p = child(); children.push(p); return p; },
        waitReady: async () => {}, sleep: async (ms) => { delays.push(ms); }, now: () => 0, log: (...args) => logs.push(args) });
    await supervisor.start();
    for (let i = 0; i < 4; i++) { children[i].emit('exit', 1); await settle(); }
    assert.deepEqual(delays, [2000, 4000, 8000]);
    assert.equal(children.length, 4);
    assert.equal(logs.at(-1)[1].code, 'PYTHON_RESTART_LIMIT');
    await supervisor.stop();
});

test('shutdown kills Python without restarting, including while health is loading', async () => {
    let spawns = 0;
    const supervisor = createPythonSupervisor({ spawnChild: () => { spawns++; return child(); },
        waitReady: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), log: () => {} });
    const ready = supervisor.start();
    await supervisor.stop();
    await assert.rejects(ready);
    assert.equal(spawns, 1);
});

test('readiness failure terminates the old process before restarting and initial failure rejects', async () => {
    let spawns = 0, kills = 0;
    const supervisor = createPythonSupervisor({ spawnChild: () => {
        spawns++; const p = child(); const kill = p.kill; p.kill = () => { kills++; return kill(); }; return p;
    }, waitReady: async () => { throw new Error('model load failed'); }, sleep: async () => {}, now: () => 0, log: () => {} });
    await assert.rejects(supervisor.start(), /model load failed/);
    assert.equal(spawns, 4);
    assert.equal(kills, 4);
    await supervisor.stop();
});

test('the restart budget resets after its five-minute window', async () => {
    let now = 0;
    const children = [], delays = [];
    const supervisor = createPythonSupervisor({ spawnChild: () => { const p = child(); children.push(p); return p; },
        waitReady: async () => {}, sleep: async (ms) => delays.push(ms), now: () => now, log: () => {} });
    await supervisor.start();
    children[0].emit('exit', 1); await settle();
    now = classifierConfig().restartWindowMs + 1;
    children[1].emit('exit', 1); await settle();
    assert.deepEqual(delays, [2000, 2000]);
    await supervisor.stop();
    assert.equal(children.length, 3);
});
