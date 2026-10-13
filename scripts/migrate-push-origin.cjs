const fs = require('node:fs');
const path = require('node:path');
const mariadb = require('mariadb');
const { loadEnvironment } = require('../config/environment.cjs');
async function migrate({ check = false } = {}) {
    loadEnvironment();
    const db = await mariadb.createConnection({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT) || 3306, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
    try {
        const existing = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='push_devices' AND COLUMN_NAME='server_origin'");
        if (!existing.length && !check) await db.query(fs.readFileSync(path.join(__dirname, '../sql/push_device_origin.sql'),'utf8'));
        console.log(`${check ? 'Pending' : 'Applied'} push origin migration: ${existing.length ? 0 : 1}`);
    } finally { await db.end(); }
}
if (require.main === module) migrate({ check: process.argv.includes('--check') }).catch(error => { console.error('Push origin migration failed:', error.code || error.message); process.exitCode = 1; });
module.exports = { migrate };
