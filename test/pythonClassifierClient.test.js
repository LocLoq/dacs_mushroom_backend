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

test('python client distinguishes transient HTTP/network errors from permanent errors', async () => {
    const imagePath = path.join(os.tmpdir(), `classifier-client-${Date.now()}-retry.png`);
    await fs.promises.writeFile(imagePath, 'image');
    const args = { lookupId: 'request-1', imagePath, originalName: 'm.png', mimeType: 'image/png' };
    try {
        for (const [status, code, retryable] of [[429, 'HTTP_429', true], [500, 'INFERENCE_FAILED', true],
            [500, 'MODEL_INVALID', false], [422, 'IMAGE_INVALID', false], [401, 'HTTP_401', false]]) {
            axios.post = async () => ({ status, data: { error: { code } } });
            await assert.rejects(classifyWithPythonService(args), (error) => error.code === code && error.retryable === retryable);
        }
        for (const [code, expected, retryable] of [['ECONNRESET', 'SERVICE_UNAVAILABLE', true], ['ECONNABORTED', 'SERVICE_TIMEOUT', true], ['ERR_CANCELED', 'CLASSIFIER_CANCELED', false]]) {
            axios.post = async () => { throw Object.assign(new Error('error'), { code }); };
            await assert.rejects(classifyWithPythonService(args), (error) => error.code === expected && error.retryable === retryable);
        }
        axios.post = async () => ({ status: 200, data: { requestId: 'wrong', result: {} } });
        await assert.rejects(classifyWithPythonService(args), (error) => error.code === 'INVALID_SERVICE_RESPONSE' && !error.retryable);
        const controller = new AbortController();
        controller.abort(Object.assign(new Error('stopping'), { code: 'WORKER_SHUTDOWN' }));
        axios.post = async () => { throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }); };
        await assert.rejects(classifyWithPythonService({ ...args, signal: controller.signal }), { code: 'WORKER_SHUTDOWN', retryable: true });
    } finally { await fs.promises.unlink(imagePath); }
    await assert.rejects(classifyWithPythonService(args), { code: 'INPUT_FILE_UNAVAILABLE', retryable: false });
});
