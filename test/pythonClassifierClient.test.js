const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { afterEach, test } = require('node:test');
const axios = require('axios');
const { classifyWithPythonService, PythonClassifierError } = require('../services/pythonClassifierClient');

const originalPost = axios.post;
afterEach(() => { axios.post = originalPost; });

test('python classifier client validates a successful service response', async () => {
    const imagePath = path.join(os.tmpdir(), `classifier-client-${Date.now()}.png`);
    await fs.promises.writeFile(imagePath, 'image');
    axios.post = async () => ({ status: 200, data: { requestId: '11111111-1111-4111-8111-111111111111', result: { name: 'Nấm sò', edibility: 'NON_POISONOUS', confidence: 0.91 } } });
    try {
        const response = await classifyWithPythonService({ lookupId: '11111111-1111-4111-8111-111111111111', imagePath, originalName: 'ảnh nấm.png', mimeType: 'image/png' });
        assert.equal(response.result.name, 'Nấm sò');
    } finally {
        await fs.promises.unlink(imagePath);
    }
});

test('python classifier client rejects malformed or failed service results', async () => {
    const imagePath = path.join(os.tmpdir(), `classifier-client-${Date.now()}-failure.png`);
    await fs.promises.writeFile(imagePath, 'image');
    axios.post = async () => ({ status: 503, data: { error: { code: 'MODEL_UNAVAILABLE', message: 'down' } } });
    try {
        await assert.rejects(
            classifyWithPythonService({ lookupId: '11111111-1111-4111-8111-111111111112', imagePath, originalName: 'm.png', mimeType: 'image/png' }),
            (error) => error instanceof PythonClassifierError && error.code === 'MODEL_UNAVAILABLE'
        );
    } finally {
        await fs.promises.unlink(imagePath);
    }
});
