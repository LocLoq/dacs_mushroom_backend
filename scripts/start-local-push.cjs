const { spawn } = require('node:child_process');
const path = require('node:path');
const { loadEnvironment } = require('../config/environment.cjs');
const { publicPushConfig } = require('../services/pushProviders');
loadEnvironment();
const config = publicPushConfig();
console.log(`Local API: ${config.apiUrl || 'http://localhost:8080'}`);
console.log(`Firebase push: ${config.channels.fcm ? 'enabled' : 'not configured; in-app notifications and refresh still available'}`);
console.log('MySQL and Redis must be running. No ntfy/distributor/account is required.');
const children = ['server.cjs', 'classifier-worker.cjs'].map(file => spawn(process.execPath,
    [path.resolve(__dirname, '..', file)], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', env: process.env, windowsHide: true }));
let stopping = false;
const stop = () => { stopping = true; for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); };
process.once('SIGINT',stop);process.once('SIGTERM',stop);
for (const child of children) {
    child.once('error',error=>{console.error(error.code||error.message);process.exitCode=1;stop();});
    child.once('exit',code=>{if (!stopping) { process.exitCode=code || 1; stop(); }});
}
