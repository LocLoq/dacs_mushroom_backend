// Apply the additive push conversion before Prisma compares a populated database.
// Fresh installations can create the complete schema directly.
const mariadb = require('mariadb');
const { spawnSync } = require('node:child_process');
const { loadEnvironment } = require('../config/environment.cjs');
async function main() {
    loadEnvironment();
    const db = await mariadb.createConnection({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT) || 3306, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
    let exists;
    try {
        exists = (await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='push_devices'")).length > 0;
    } finally { await db.end(); }
    if (exists) {
        await require('./migrate-push.cjs').migrate();
        await require('./migrate-firebase-push.cjs').migrate();
        await require('./migrate-push-origin.cjs').migrate();
    }
    const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = spawnSync(executable, ['prisma', 'db', 'push', '--config', 'prisma.config.ts'], { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
    if (result.status !== 0) throw new Error('Prisma schema initialization failed');
}
if (require.main === module) main().catch(error => { console.error('Database initialization failed:', error.code || error.message); process.exitCode = 1; });
module.exports = { main };
