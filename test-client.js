const io = require('socket.io-client');
const FormData = require('form-data');
const fs = require('fs');
const axios = require('axios');

async function runTest() {
    const baseUrl = process.env.API_BASE_URL || 'http://localhost:8080';
    const imagePath = process.argv[2] || 'dummy.jpg';
    if (!fs.existsSync(imagePath)) throw new Error('Usage: node test-client.js <image-path>');
    const socket = io(baseUrl, { transports: ['websocket'] });
    let jobId, reading = false, dirty = false, finished = false;
    let pollTimer;
    const close = (failed) => {
        finished = true; clearInterval(pollTimer); socket.disconnect();
        process.exitCode = failed ? 1 : 0;
    };
    const refresh = async () => {
        if (!jobId || finished) return;
        if (reading) { dirty = true; return; }
        reading = true;
        try {
            do {
                dirty = false;
                const response = await axios.get(baseUrl + '/api/mushroom-classifier/jobs/' + jobId);
                const snapshot = response.data.data;
                console.log('API snapshot:', snapshot);
                if (snapshot.status === 'SUCCEEDED' || snapshot.status === 'FAILED') close(snapshot.status === 'FAILED');
            } while (dirty && !finished);
        } catch (error) { console.error('Unable to refresh job:', error.response?.status || error.message); }
        finally { reading = false; }
    };
    socket.on('connect', () => { if (jobId) { socket.emit('subscribe_job', jobId); void refresh(); } });
    socket.on('refresh', (message) => { if (message?.resource === 'classifier-job' && message.id === jobId) void refresh(); });
    pollTimer = setInterval(() => { if (!socket.connected) void refresh(); }, 5000);
    try {
        const form = new FormData(); form.append('image', fs.createReadStream(imagePath));
        const response = await axios.post(baseUrl + '/api/mushroom-classifier/classify', form, { headers: form.getHeaders() });
        jobId = response.data.jobId;
        if (!jobId) throw new Error('Server did not return a job ID');
        if (socket.connected) socket.emit('subscribe_job', jobId);
        await refresh();
    } catch (error) { close(true); throw error; }
}
runTest().catch((error) => { console.error(error.response?.data || error.message); process.exitCode = 1; });
