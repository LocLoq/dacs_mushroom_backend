const Queue = require('bull');
const sendMushroomClassifierReq = require('../jobs/mushroom');

const mushroomClassifierQueue = new Queue('mushroomClassifierQueue', process.env.REDIS_URL);

mushroomClassifierQueue.process(async job => {
    const { slug, service } = job.data;

    try {
        switch (service) {
            case 'mushroom': {
                const response = await sendMushroomClassifierReq(job);
                return Promise.resolve({ sent: true, slug });
            }
            default: {
                return Promise.resolve({ sent: true, slug });
            }
        }
    } catch (err) {
        return Promise.reject(err);
    }
});

module.exports = mushroomClassifierQueue;
