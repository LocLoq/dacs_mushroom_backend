const Queue = require('bull');
const sendMushroomClassifierReq = require('../jobs/mushroom');

const mushroomClassifierQueue = new Queue('mushroomClassifierQueue', process.env.REDIS_URL);

mushroomClassifierQueue.process(async (job) => sendMushroomClassifierReq(job));

module.exports = mushroomClassifierQueue;
