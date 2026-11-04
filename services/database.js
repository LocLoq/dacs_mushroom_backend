const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

function createDatabase(defaultLimit = 10) {
    const limit = Number(process.env.DATABASE_POOL_SIZE || defaultLimit);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('DATABASE_POOL_SIZE must be a positive integer');
    const factory = new PrismaMariaDb({ host: process.env.DATABASE_HOST, user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME,
        port: Number(process.env.DATABASE_PORT) || 3306, connectionLimit: limit });
    let pool;
    const connect = factory.connect.bind(factory);
    factory.connect = async () => { const adapter = await connect(); pool = adapter.underlyingDriver(); return adapter; };
    return { prisma: new PrismaClient({ adapter: factory }), limit, pool: () => pool };
}
module.exports = { createDatabase };
