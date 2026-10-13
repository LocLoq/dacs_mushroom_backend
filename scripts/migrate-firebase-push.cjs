const fs = require('node:fs');
const path = require('node:path');
const mariadb = require('mariadb');
const { loadEnvironment } = require('../config/environment.cjs');
async function migrate({ check = false } = {}) {
    loadEnvironment();
    const db = await mariadb.createConnection({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT) || 3306, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
    try {
        const pending = await db.query("SELECT COUNT(*) total FROM push_deliveries d JOIN push_devices p ON p.id=d.device_id WHERE p.provider IN ('unifiedpush','apns') AND d.sent_at IS NULL AND d.cancelled_at IS NULL");
        const active = await db.query("SELECT COUNT(*) total FROM push_devices WHERE provider IN ('unifiedpush','apns') AND active=true");
        if (!check) {
            await db.beginTransaction();
            for (const sql of fs.readFileSync(path.join(__dirname, '../sql/firebase_push.sql'), 'utf8').replace(/--[^\n]*/g,'').split(';').map(s => s.trim()).filter(Boolean)) await db.query(sql);
            await db.commit();
        }
        console.log(`${check ? 'Pending' : 'Converted'} Firebase switch: ${Number(active[0].total)} retired devices, ${Number(pending[0].total)} pending deliveries. History preserved.`);
    } catch (error) { if (!check) await db.rollback(); throw error; }
    finally { await db.end(); }
}
if (require.main === module) migrate({ check: process.argv.includes('--check') }).catch(error => { console.error('Firebase migration failed:', error.code || error.message); process.exitCode = 1; });
module.exports = { migrate };
