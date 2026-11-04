const { loadEnvironment } = require('./config/environment.cjs');
loadEnvironment();
const database = require('./services/database').createDatabase(4);
global.prisma = database.prisma;
const Redis = require('ioredis');
const { Emitter } = require('@socket.io/redis-emitter');
const socketPublisher = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
socketPublisher.on('error', error => console.error('Classifier socket Redis error:', error.message));
global.io = new Emitter(socketPublisher);
const queue = require('./queues/mushroomClassifierQueue');
const { createClassifierMonitor, cleanStaleClassifierFiles } = require('./services/classifierMonitor');
const { activeRequests } = require('./services/classifierLifecycle');
const worker = queue.startWorker();
const monitor = createClassifierMonitor({ prisma: database.prisma, queue });
const stopMetrics = require('./services/runtimeMetrics').start('worker', database, queue);
monitor.start(worker);
void cleanStaleClassifierFiles(database.prisma);
let stopping = false;
async function shutdown() {
    if (stopping) return; stopping = true; stopMetrics();
    for (const active of activeRequests.values()) active.controller.abort(Object.assign(new Error('Worker stopping'), { code: 'WORKER_SHUTDOWN' }));
    try { await monitor.stop(worker); await Promise.all([worker.close(), queue.close()]); await database.prisma.$disconnect(); }
    finally { socketPublisher.disconnect(); process.exit(0); }
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
