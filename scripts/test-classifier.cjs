const { spawnSync } = require('child_process');
const result = spawnSync(process.execPath, ['--test', 'test/classifierIntegration.test.js'], {
    stdio: 'inherit', env: { ...process.env, RUN_CLASSIFIER_INTEGRATION: '1' }, windowsHide: true
});
process.exitCode = result.status ?? 1;
