const { spawnSync } = require('child_process');

const result = spawnSync(process.execPath, ['--test', 'test/workflowIntegration.test.js'], {
    stdio: 'inherit', env: { ...process.env, RUN_DB_INTEGRATION: '1' }
});
process.exit(result.status ?? 1);
