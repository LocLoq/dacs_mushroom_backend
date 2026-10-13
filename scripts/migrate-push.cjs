const fs = require('node:fs');
const path = require('node:path');
const mariadb = require('mariadb');
const { loadEnvironment } = require('../config/environment.cjs');
async function migrate({ check = false } = {}) {
    loadEnvironment();
    const db = await mariadb.createConnection({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT) || 3306, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
    try {
        const columns = await db.query("SELECT COLUMN_NAME name, IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='push_devices'");
        const deliveryColumns = await db.query("SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='push_deliveries'");
        const has = name => columns.some(c => c.name === name);
        const statements = fs.readFileSync(path.join(__dirname, '../sql/unifiedpush_apns.sql'), 'utf8').split(';').map(s => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean);
        const pendingLegacy = has('provider') && deliveryColumns.some(c => c.name === 'cancelled_at') ? Number((await db.query("SELECT COUNT(*) total FROM push_deliveries d JOIN push_devices p ON p.id=d.device_id WHERE d.sent_at IS NULL AND d.cancelled_at IS NULL AND p.provider='legacy'"))[0].total) : 1;
        let count = 0;
        for (let i = 0; i < statements.length; i++) {
            if (i === 0 && has('provider')) continue;
            if ((i === 1 || i === 2) && columns.find(c => c.name === 'identity_hash')?.nullable === 'NO') continue;
            if (i === 3 && deliveryColumns.some(c => c.name === 'cancelled_at')) continue;
            if (i === 4 && !pendingLegacy) continue;
            if (!check) await db.query(statements[i]); count++;
        }
        console.log(`${check ? 'Pending' : 'Applied'} push migration statements: ${count}`);
    } finally { await db.end(); }
}
if (require.main === module) migrate({ check: process.argv.includes('--check') }).catch(error => { console.error('Push migration failed:', error.code || error.message); process.exitCode = 1; });
module.exports = { migrate };
