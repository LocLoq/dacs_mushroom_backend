const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

class PythonClassifierError extends Error {
    constructor(code, message, retryable = false) {
        super(message);
        this.name = 'PythonClassifierError';
        this.code = code;
        this.retryable = retryable;
    }
}

const assertResult = (payload, requestId) => {
    if (!payload || payload.requestId !== requestId || !payload.result || typeof payload.result !== 'object') {
        throw new PythonClassifierError('INVALID_SERVICE_RESPONSE', 'Python classifier trả về dữ liệu không hợp lệ');
    }
    const { result } = payload;
    if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 || typeof result.name !== 'string' || typeof result.edibility !== 'string') {
        throw new PythonClassifierError('INVALID_SERVICE_RESPONSE', 'Kết quả classifier không đúng schema');
    }
    return payload;
};

async function classifyWithPythonService({ lookupId, imagePath, originalName, mimeType }) {
    const form = new FormData();
    form.append('requestId', lookupId);
    form.append('image', fs.createReadStream(imagePath), { filename: originalName, contentType: mimeType });
    const headers = form.getHeaders();
    if (process.env.CLASSIFIER_SERVICE_TOKEN) headers['x-classifier-token'] = process.env.CLASSIFIER_SERVICE_TOKEN;
    const baseUrl = (process.env.CLASSIFIER_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
    try {
        const response = await axios.post(`${baseUrl}/v1/classify`, form, {
            headers,
            timeout: Number(process.env.CLASSIFIER_TIMEOUT_MS || 120000),
            maxBodyLength: 6 * 1024 * 1024,
            maxContentLength: 1024 * 1024,
            validateStatus: () => true
        });
        if (response.status < 200 || response.status >= 300) {
            const code = response.data?.error?.code || `HTTP_${response.status}`;
            throw new PythonClassifierError(code, response.data?.error?.message || 'Python classifier không thể xử lý ảnh', response.status >= 500);
        }
        return assertResult(response.data, lookupId);
    } catch (error) {
        if (error instanceof PythonClassifierError) throw error;
        if (error.code === 'ECONNABORTED') throw new PythonClassifierError('SERVICE_TIMEOUT', 'Python classifier quá thời gian xử lý', true);
        throw new PythonClassifierError('SERVICE_UNAVAILABLE', 'Không thể kết nối Python classifier', true);
    }
}

module.exports = { classifyWithPythonService, PythonClassifierError };
