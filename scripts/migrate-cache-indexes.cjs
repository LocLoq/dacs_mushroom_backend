const mariadb = require('mariadb');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvironment } = require('../config/environment.cjs');
const definitions = [
  ['cultivation_care_logs', 'bench_care_batch_recorded_id', ['batch_id', 'recorded_at', 'id']],
  ['growth_progress_records', 'bench_growth_batch_recorded_id', ['batch_id', 'recorded_at', 'id']],
  ['cultivation_batches', 'bench_batch_facility_start_id', ['facility_id', 'start_date', 'id']],
  ['tasks', 'bench_task_assignee_status_due', ['assignee_user_id', 'status', 'due_at']]
];
async function migrate({ check = false } = {}) {
  loadEnvironment();
  const db = await mariadb.createConnection({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT || 3306), user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME });
  try {
    const evidence = async phase => {
      if (!process.env.INDEX_EVIDENCE_DIR) return;
      const folder = path.resolve(process.env.INDEX_EVIDENCE_DIR); fs.mkdirSync(folder, { recursive: true });
      const queries = {
        care: 'EXPLAIN SELECT id FROM cultivation_care_logs WHERE batch_id=1 ORDER BY recorded_at DESC,id DESC LIMIT 20',
        growth: 'EXPLAIN SELECT id FROM growth_progress_records WHERE batch_id=1 ORDER BY recorded_at DESC,id DESC LIMIT 20',
        batches: 'EXPLAIN SELECT id FROM cultivation_batches WHERE facility_id=1 ORDER BY start_date DESC,id DESC LIMIT 20',
        tasks: "EXPLAIN SELECT id FROM tasks WHERE assignee_user_id=1 AND status='TODO' ORDER BY due_at LIMIT 20"
      };
      const plans = {};
      for (const [name, sql] of Object.entries(queries)) plans[name] = await db.query(sql);
      fs.writeFileSync(path.join(folder, `explain-${phase}.json`), JSON.stringify(plans, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    };
    await evidence('before');
    for (const [table, name, columns] of definitions) {
      const rows = await db.query('SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX', [table]);
      const indexes = {};
      for (const row of rows) (indexes[row.INDEX_NAME] ||= []).push(row.COLUMN_NAME);
      const covered = Object.values(indexes).some(existing => columns.every((column, i) => existing[i] === column));
      if (!covered && !check) await db.query(`CREATE INDEX \`${name}\` ON \`${table}\` (${columns.map(column => `\`${column}\``).join(', ')})`);
      console.log(`${table}: ${covered ? 'covered' : check ? 'missing' : 'created'}`);
    }
    await evidence('after');
  } finally { await db.end(); }
}
if (require.main === module) migrate({ check: process.argv.includes('--check') }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { migrate, definitions };
