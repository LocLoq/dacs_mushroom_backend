const { loadEnvFile } = require('node:process');

function loadEnvironment(envFile = '.env') {
    try {
        loadEnvFile(envFile);
    } catch (error) {
        // Containers receive environment variables directly; a local file is optional.
        if (error.code !== 'ENOENT') throw error;
    }
}

function getDatabaseUrl(environment = process.env) {
    if (environment.DATABASE_URL) return environment.DATABASE_URL;
    const { DATABASE_HOST: host, DATABASE_USER: user, DATABASE_NAME: database } = environment;
    if (!host || !user || !database) return undefined;
    const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const password = environment.DATABASE_PASSWORD || '';
    const port = environment.DATABASE_PORT || '3306';
    return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${hostname}:${port}/${encodeURIComponent(database)}`;
}

module.exports = { loadEnvironment, getDatabaseUrl };
