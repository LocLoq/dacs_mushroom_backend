const io = require('socket.io-client');
const FormData = require('form-data');
const fs = require('fs');
const axios = require('axios');

async function runTest() {
    console.log('Connecting to socket server...');
    const socket = io('http://localhost:8080');

    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
    });

    socket.on('processing', (data) => {
        console.log('Received message from server [PROCESSING]:', data);
    });

    socket.on('finished', (data) => {
        console.log('Received message from server [FINISHED]:', data);
        console.log('Test completed successfully. Disconnecting...');
        socket.disconnect();
        process.exit(0);
    });

    // Create a dummy image file for testing
    fs.writeFileSync('dummy.jpg', 'fake image content');

    const form = new FormData();
    form.append('image', fs.createReadStream('dummy.jpg'));

    console.log('Sending POST request to /api/mushroom/classify...');
    
    try {
        const response = await axios.post('http://localhost:8080/api/mushroom/classify', form, {
            headers: form.getHeaders()
        });
        
        console.log('POST Response:', response.data);
        
        if (response.data.jobId) {
            console.log(`Subscribing to job_${response.data.jobId}...`);
            socket.emit('subscribe_job', response.data.jobId);
        } else {
            console.error('No jobId received!');
            process.exit(1);
        }
    } catch (err) {
        console.error('Error during POST request:', err.response ? err.response.data : err.message);
        process.exit(1);
    }
}

runTest();

