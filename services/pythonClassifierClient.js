const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { classifierConfig } = require('../config/classifier.cjs');

const permanentServiceErrors = new Set(['MODEL_MISSING', 'MODEL_INVALID', 'MODEL_METADATA_MISMATCH', 'MODEL_METADATA_INVALID',
    'CATALOG_INVALID', 'LABELS_MISSING', 'LABELS_INVALID', 'DEVICE_INVALID', 'CUDA_UNAVAILABLE']);

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

async function classifyWithPythonService({ lookupId, imagePath, originalName, mimeType, signal }) {
    try { await fs.promises.access(imagePath, fs.constants.R_OK); }
    catch (_) { throw new PythonClassifierError('INPUT_FILE_UNAVAILABLE', 'Ảnh nhận diện không còn khả dụng'); }
    const form = new FormData();
    const imageStream = fs.createReadStream(imagePath);
    form.append('requestId', lookupId);
    form.append('image', imageStream, { filename: originalName, contentType: mimeType });
    const headers = form.getHeaders();
    if (process.env.CLASSIFIER_SERVICE_TOKEN) headers['x-classifier-token'] = process.env.CLASSIFIER_SERVICE_TOKEN;
    const baseUrl = (process.env.CLASSIFIER_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
    try {
        const response = await axios.post(`${baseUrl}/v1/classify`, form, {
            headers,
            timeout: classifierConfig().timeoutMs,
            signal,
            maxBodyLength: 6 * 1024 * 1024,
            maxContentLength: 1024 * 1024,
            validateStatus: () => true
        });
        if (response.status < 200 || response.status >= 300) {
            const code = response.data?.error?.code || `HTTP_${response.status}`;
            throw new PythonClassifierError(code, response.data?.error?.message || 'Python classifier không thể xử lý ảnh',
                !permanentServiceErrors.has(code) && (response.status === 429 || response.status >= 500));
        }
        return assertResult(response.data, lookupId);
    } catch (error) {
        if (error instanceof PythonClassifierError) throw error;
        if (error.code === 'ERR_CANCELED') {
            if (signal?.reason?.code === 'WORKER_SHUTDOWN') throw new PythonClassifierError('WORKER_SHUTDOWN', 'Backend đang khởi động lại', true);
            throw new PythonClassifierError('CLASSIFIER_CANCELED', 'Lượt nhận diện đã kết thúc');
        }
        if (['ENOENT', 'EACCES', 'EISDIR'].includes(error.code)) throw new PythonClassifierError('INPUT_FILE_UNAVAILABLE', 'Ảnh nhận diện không còn khả dụng');
        if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) throw new PythonClassifierError('SERVICE_TIMEOUT', 'Python classifier quá thời gian xử lý', true);
        throw new PythonClassifierError('SERVICE_UNAVAILABLE', 'Không thể kết nối Python classifier', true);
    } finally {
        imageStream.destroy();
    }
}

module.exports = { classifyWithPythonService, PythonClassifierError };
