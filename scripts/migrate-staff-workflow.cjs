const fs = require('node:fs');
const path = require('node:path');
const mariadb = require('mariadb');
const { loadEnvironment } = require('../config/environment.cjs');

async function migrate({ check = false } = {}) {
    loadEnvironment();
    const connection = await mariadb.createConnection({
        host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT) || 3306,
        user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD,
        database: process.env.DATABASE_NAME, connectTimeout: 5000
    });
    try {
        const database = process.env.DATABASE_NAME;
        const tables = new Set((await connection.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database])).map((row) => row.name));
        const columns = new Set((await connection.query('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [database, 'classifier_lookups'])).map((row) => row.name));
        const careColumn = await connection.query('SELECT CHARACTER_MAXIMUM_LENGTH AS maximumLength FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [database, 'cultivation_care_logs', 'action_type']);
        const careWidthReady = Number(careColumn[0]?.maximumLength) >= 255;
        const constraints = new Set((await connection.query('SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ?', [database])).map((row) => row.name));
        const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'staff_care_notifications.sql'), 'utf8');
        let applied = 0;
        for (const original of sql.split(';').map((part) => part.replace(/--[^\n]*/g, '').trim()).filter(Boolean)) {
            let statement = original;
            if (statement.startsWith('ALTER TABLE `cultivation_care_logs`') && careWidthReady) continue;
            const create = /^CREATE TABLE `([^\`]+)`/.exec(statement);
            const foreign = /ADD CONSTRAINT `([^\`]+)`/.exec(statement);
            if (create && tables.has(create[1]) || foreign && constraints.has(foreign[1])) continue;
            if (statement.startsWith('ALTER TABLE `classifier_lookups`')) {
                const additions = statement.slice(statement.indexOf('ADD COLUMN')).split(/,\s*(?=ADD COLUMN)/).filter((part) => !columns.has(/ADD COLUMN `([^\`]+)`/.exec(part)[1]));
                if (!additions.length) continue;
                statement = 'ALTER TABLE `classifier_lookups` ' + additions.join(', ');
            }
            if (!check) await connection.query(statement);
            applied++;
        }
        console.log(`${check ? 'Pending' : 'Applied'} staff workflow migration statements: ${applied}; database: ${database}`);
    } finally { await connection.end(); }
}
if (require.main === module) migrate({ check: process.argv.includes('--check') }).catch((error) => {
    console.error('Staff workflow migration failed:', { code: error.code, message: error.message }); process.exitCode = 1;
});
module.exports = { migrate };

