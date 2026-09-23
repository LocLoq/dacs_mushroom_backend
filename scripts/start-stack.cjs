const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config({ quiet: true });

const root = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const children = new Set();

const run = (command, args, label, waitForExit = true) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env, shell: false });
    children.add(child);
    child.once('error', (error) => {
        children.delete(child);
        if (waitForExit) reject(new Error(`${label} không thể khởi động: ${error.message}`));
        else console.error(`${label} không thể khởi động: ${error.message}`);
    });
    if (!waitForExit) return resolve(child);
    child.once('exit', (code, signal) => {
        children.delete(child);
        if (code === 0) resolve(); else reject(new Error(`${label} kết thúc với ${signal || `mã ${code}`}`));
    });
});

const stopAll = () => {
    for (const child of children) if (!child.killed) child.kill('SIGTERM');
};
process.once('SIGINT', () => { stopAll(); process.exit(0); });
process.once('SIGTERM', () => { stopAll(); process.exit(0); });

async function waitForClassifier() {
    const baseUrl = (process.env.CLASSIFIER_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) return;
        } catch (_) { /* service is still loading model */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Python classifier không sẵn sàng sau 60 giây');
}

async function main() {
    await run(isWindows ? 'cmd.exe' : 'npm', isWindows ? ['/d', '/s', '/c', 'npm run prisma:generate'] : ['run', 'prisma:generate'], 'Prisma');
    if (process.env.SKIP_SEED !== '1') await run(isWindows ? 'cmd.exe' : 'npm', isWindows ? ['/d', '/s', '/c', 'npm run db:seed'] : ['run', 'db:seed'], 'Seed dữ liệu demo');

    const python = process.env.CLASSIFIER_PYTHON_BIN || (isWindows ? 'py' : 'python3');
    const pythonArgs = isWindows ? ['-3.12', 'helper/mushroom_classifier/server.py'] : ['helper/mushroom_classifier/server.py'];
    const pythonProcess = await run(python, pythonArgs, 'Python classifier', false);
    try {
        await waitForClassifier();
    } catch (error) {
        pythonProcess.kill('SIGTERM');
        throw error;
    }
    console.log('Python classifier đã sẵn sàng; khởi động API Node...');
    try {
        await run(process.execPath, ['server.cjs'], 'API Node');
    } finally {
        stopAll();
    }
}

main().catch((error) => { console.error(error.message); stopAll(); process.exitCode = 1; });
