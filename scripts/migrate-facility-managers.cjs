const fs = require('node:fs');
const path = require('node:path');
const mariadb = require('mariadb');
const { loadEnvironment } = require('../config/environment.cjs');

async function migrate() {
    loadEnvironment();
    const connection = await mariadb.createConnection({
        host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT) || 3306,
        user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD,
        database: process.env.DATABASE_NAME, connectTimeout: 5000
    });
    try {
        await connection.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'facility_managers.sql'), 'utf8'));
        console.log('Facility manager migration applied. Assign managers using an admin account.');
    } finally { await connection.end(); }
}
if (require.main === module) migrate().catch(error => { console.error('Facility manager migration failed:', error.code || error.message); process.exitCode = 1; });
module.exports = { migrate };
