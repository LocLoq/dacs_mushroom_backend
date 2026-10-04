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

const pagination = (query, maximum = 50) => {
    const page = query.page === undefined ? 1 : id(query.page);
    const limit = Math.min(query.limit === undefined ? 10 : id(query.limit), maximum);
    if (!Number.isSafeInteger((page - 1) * limit)) fail(400, 'Trang vượt giới hạn');
    return { page, limit, skip: (page - 1) * limit };
};

const pageResponse = (data, totalItems, { page, limit }) => ({
    data, pagination: { totalItems, currentPage: page, totalPages: Math.ceil(totalItems / limit), pageSize: limit }
});

const fields = (body, allowed) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some((key) => !allowed.includes(key))) fail(400, 'Dữ liệu không hợp lệ');
};

const textField = (value, name, maximum = 500, nullable = false) => {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || (!nullable && !value.trim()) || value.trim().length > maximum) fail(400, `${name} không hợp lệ`);
    return value.trim() || null;
};

const dateField = (value, name) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) fail(400, `${name} phải là ngày hoặc ISO 8601 có múi giờ`);
    const result = new Date(value);
    if (Number.isNaN(result.getTime())) fail(400, `${name} không hợp lệ`);
    const day = value.slice(0, 10);
    const calendarDate = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== day) fail(400, `${name} không hợp lệ`);
    return result;
};

const handle = (handler) => async (req, res) => {
    try { await handler(req, res); } catch (error) {
        const conflict = ['P2025', 'P2003', 'P2034'].includes(error.code);
        const status = error.status || (conflict ? 409 : 500);
        if (status === 500) console.error(error);
        res.status(status).json({ code: status === 403 ? 'AUTH_FORBIDDEN' : status === 409 ? 'STATE_CONFLICT' : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: status === 500 ? 'Lỗi máy chủ' : conflict ? 'Dữ liệu đã thay đổi; vui lòng tải lại' : error.message });
    }
};

module.exports = { fail, id, pagination, pageResponse, fields, textField, dateField, handle };
