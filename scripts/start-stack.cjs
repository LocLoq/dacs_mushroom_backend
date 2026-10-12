const { spawn, spawnSync } = require('child_process');
const path = require('path');
require('dotenv').config({ quiet: true });
const { classifierConfig } = require('../config/classifier.cjs');
const { createPythonSupervisor } = require('../services/pythonSupervisor');

const root = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const children = new Set();
let pythonSupervisor;
let stopping = false;

const run = (command, args, label) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env, shell: false, windowsHide: true });
    children.add(child);
    child.once('error', (error) => {
        children.delete(child);
        reject(new Error(`${label} không thể khởi động: ${error.message}`));
    });
    child.once('exit', () => children.delete(child));
    child.once('exit', (code, signal) => {
        children.delete(child);
        if (code === 0) resolve(); else reject(new Error(`${label} kết thúc với ${signal || `mã ${code}`}`));
    });
});

const stopAll = () => {
    stopping = true;
    void pythonSupervisor?.stop();
    for (const child of children) if (!child.killed) child.kill('SIGTERM');
};
process.once('SIGINT', () => { stopAll(); process.exit(0); });
process.once('SIGTERM', () => { stopAll(); process.exit(0); });

async function waitForClassifier(signal) {
    const config = classifierConfig();
    const baseUrl = (process.env.CLASSIFIER_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
    const deadline = Date.now() + config.startupTimeoutMs;
    while (!stopping && !signal.aborted && Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(config.healthTimeoutMs)]) });
            if (response.ok && (await response.json()).status === 'ready') return;
        } catch (_) { /* service is still loading model */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Python classifier không sẵn sàng sau ${config.startupTimeoutMs} ms`);
}

async function main() {
    await run(isWindows ? 'cmd.exe' : 'npm', isWindows ? ['/d', '/s', '/c', 'npm run prisma:generate'] : ['run', 'prisma:generate'], 'Prisma');
    if (process.env.SKIP_SEED !== '1') await run(isWindows ? 'cmd.exe' : 'npm', isWindows ? ['/d', '/s', '/c', 'npm run db:seed'] : ['run', 'db:seed'], 'Seed dữ liệu demo');

    let python = process.env.CLASSIFIER_PYTHON_BIN || (isWindows ? 'py' : 'python3');
    if (isWindows && /^py(?:\.exe)?$/i.test(path.basename(python))) {
        // Supervise the interpreter itself, so stopping a launcher cannot orphan Python.
        const resolved = spawnSync(python, ['-3.12', '-c', 'import sys; print(sys.executable)'], {
            encoding: 'utf8', cwd: root, windowsHide: true
        });
        if (resolved.status !== 0 || !resolved.stdout?.trim()) throw new Error('Không thể tìm Python 3.12');
        python = resolved.stdout.trim();
    }
    const pythonArgs = ['helper/mushroom_classifier/server.py'];
    pythonSupervisor = createPythonSupervisor({
        spawnChild: () => {
            const child = spawn(python, pythonArgs, { cwd: root, stdio: 'inherit', env: process.env, shell: false, windowsHide: true });
            children.add(child);
            child.once('exit', () => children.delete(child));
            child.once('error', () => children.delete(child));
            return child;
        },
        waitReady: waitForClassifier
    });
    await pythonSupervisor.start();
    console.log('Python classifier đã sẵn sàng; khởi động API Node...');
    try {
        await run(process.execPath, ['server.cjs'], 'API Node');
    } finally {
        stopAll();
    }
}

main().catch((error) => { console.error(error.message); stopAll(); process.exitCode = 1; });
