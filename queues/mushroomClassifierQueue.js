const Queue = require('bull');
const { createMushroomClassifierProcessor } = require('../jobs/mushroom');
const { classifierConfig, retryDelay } = require('../config/classifier.cjs');
const { createClassifierHealth } = require('../services/classifierHealth');

function createClassifierQueue({ redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    name = 'mushroomClassifierQueue', config = classifierConfig() } = {}) {
    // Only the producer fails fast. Blocking worker/subscriber connections must reconnect.
    const producer = new Queue(name, redisUrl, {
        redis: { enableOfflineQueue: false, maxRetriesPerRequest: 0, autoResendUnfulfilledCommands: false,
            connectTimeout: config.healthTimeoutMs, commandTimeout: config.healthTimeoutMs },
        defaultJobOptions: { attempts: config.attempts, backoff: { type: 'classifier', delay: config.backoffMs },
            removeOnComplete: true, removeOnFail: 1000 }
    });
    producer.on('error', (error) => console.error('Classifier producer Redis error:', { code: error.code || 'REDIS_ERROR', message: error.message }));
    producer.health = createClassifierHealth({ queue: producer, config });
    producer.classifierConfig = config;
    producer.startWorker = (processor) => {
        if (producer.worker) return producer.worker;
        const worker = new Queue(name, redisUrl, {
            settings: { backoffStrategies: { classifier: (attemptsMade) => retryDelay(attemptsMade, config.backoffMs) } }
        });
        worker.on('error', (error) => console.error('Classifier worker Redis error:', { code: error.code || 'REDIS_ERROR', message: error.message }));
        worker.on('stalled', (job) => console.error('Classifier job stalled:', { jobId: job.id, code: 'JOB_STALLED', attempt: job.attemptsMade }));
        worker.process(1, processor || createMushroomClassifierProcessor({ checkHealth: producer.health.pythonReady, config }))
            .catch((error) => console.error('Classifier worker initialization failed:', { code: error.code, message: error.message }));
        producer.worker = worker;
        return worker;
    };
    return producer;
}

module.exports = createClassifierQueue();
module.exports.createClassifierQueue = createClassifierQueue;
