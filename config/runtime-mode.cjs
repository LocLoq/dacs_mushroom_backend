const fs = require('node:fs');
const path = require('node:path');

// The image owns this file; environment variables cannot disable production limits.
function runtimeMode(file = path.join(__dirname, '..', 'runtime-mode.json')) {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')).mode; }
    catch (error) { if (error.code === 'ENOENT') return 'production'; throw error; }
    if (!['production', 'benchmark'].includes(value)) throw new Error('Invalid runtime image mode');
    return value;
}
module.exports = { runtimeMode };
