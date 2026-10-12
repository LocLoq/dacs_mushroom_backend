const fail = (status, message, code) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
};

const id = (value) => {
    if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) fail(400, 'ID không hợp lệ');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(400, 'ID không hợp lệ');
    return parsed;
};

const pagination = (query, maximum = 50, defaultLimit = 10) => {
    const page = query.page === undefined ? 1 : id(query.page);
    const limit = Math.min(query.limit === undefined ? defaultLimit : id(query.limit), maximum);
    if (!Number.isSafeInteger((page - 1) * limit)) fail(400, 'Trang vượt giới hạn');
    return { page, limit, skip: (page - 1) * limit };
};

const pageResponse = (data, totalItems, { page, limit }) => ({
    data, pagination: { totalItems, currentPage: page, totalPages: Math.ceil(totalItems / limit), pageSize: limit }
});

const fields = (body, allowed, { allowEmpty = false } = {}) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || (!allowEmpty && !Object.keys(body).length) || Object.keys(body).some((key) => !allowed.includes(key))) fail(400, 'Dữ liệu không hợp lệ');
};

const numberField = (value, name, { min = -Infinity, max = Infinity, integer = false, nullable = false } = {}) => {
    if (nullable && value === null) return null;
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()))) fail(400, `${name} không hợp lệ`);
    const result = Number(value);
    if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isSafeInteger(result))) fail(400, `${name} không hợp lệ`);
    return result;
};

const textField = (value, name, maximum = 500, nullable = false) => {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || (!nullable && !value.trim()) || value.trim().length > maximum) fail(400, `${name} không hợp lệ`);
    return value.trim() || null;
};

const dateField = (value, name) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value)) fail(400, `${name} phải là ngày hoặc ISO 8601 có múi giờ`);
    const result = new Date(value);
    if (Number.isNaN(result.getTime())) fail(400, `${name} không hợp lệ`);
    const day = value.slice(0, 10);
    const calendarDate = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== day) fail(400, `${name} không hợp lệ`);
    return result;
};

const errorHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const conflict = ['P2002', 'P2025', 'P2003', 'P2034'].includes(error.code);
    const validation = error.name === 'PrismaClientValidationError';
    const requestedStatus = error.status || error.statusCode;
    const hasStatus = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599;
    const status = hasStatus ? requestedStatus : conflict ? 409 : validation ? 400 : 500;
    if (status >= 500) console.error(error);
    const code = hasStatus && typeof error.code === 'string' && error.code.length && !/^P\d{4}$/.test(error.code)
        ? error.code : status === 403 ? 'AUTH_FORBIDDEN' : status === 409 ? 'STATE_CONFLICT' : status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
    const message = status === 500 ? 'Lỗi máy chủ'
        : conflict && !hasStatus ? 'Dữ liệu đã thay đổi; vui lòng tải lại'
        : validation || error.type === 'entity.parse.failed' ? 'Dữ liệu không hợp lệ' : error.message;
    return res.status(status).json({ code, message });
};

const handle = (handler) => async (req, res, next) => {
    try { return await handler(req, res, next); } catch (error) { return errorHandler(error, req, res, next); }
};

module.exports = { fail, id, pagination, pageResponse, fields, textField, numberField, dateField, handle, errorHandler };
