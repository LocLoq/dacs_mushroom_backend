async function sendMushroomClassifierReq(job) {
    const { jobId, originalName } = job.data;
    
    // Emit 'processing' event to the specific job room
    if (global.io) {
        global.io.to(`job_${jobId}`).emit('processing', {
            jobId,
            status: 'processing',
            message: `Started processing image: ${originalName || 'unknown'}`
        });
    } else {
        console.warn('global.io is not defined');
    }

    console.log(`Job ${jobId}: Processing started...`);

    // Simulate the job by waiting 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log(`Job ${jobId}: Processing finished.`);

    const mockResult = {
        name: 'Amanita muscaria',
        edibility: 'Poisonous',
        confidence: 0.98
    };

    // Emit 'finished' event to the specific job room
    if (global.io) {
        global.io.to(`job_${jobId}`).emit('finished', {
            jobId,
            status: 'finished',
            message: `Finished processing image: ${originalName || 'unknown'}`,
            result: mockResult
        });
    }

    return { success: true, result: mockResult };
}

module.exports = sendMushroomClassifierReq;