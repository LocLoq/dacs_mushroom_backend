const jwt = require('jsonwebtoken');
const { fail, handle } = require('../services/apiHelpers');

const invalidToken = () => fail(401, 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ', 'AUTH_INVALID_TOKEN');

const getBearerToken = (req) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const [scheme, token] = header.trim().split(/\s+/, 2);
    return scheme === 'Bearer' && token ? token : null;
};

const resolveUser = async (token) => {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!Number.isInteger(decoded.id) || typeof decoded.username !== 'string' || !Number.isInteger(decoded.tokenver)) return null;
    const user = await global.prisma.user.findUnique({
        where: { id: decoded.id },
        include: { role: { select: { name: true } } }
    });
    if (!user || user.username !== decoded.username || user.tokenver !== decoded.tokenver || !global.allRoles.includes(user.role?.name)) return null;
    return { id: user.id, username: user.username, role: user.role.name, tokenver: user.tokenver, must_change_password: user.must_change_password === true };
};

const resolutions = new WeakMap();
const resolveRequestUser = (req) => {
    if (!resolutions.has(req)) {
        const token = getBearerToken(req);
        const resolution = token ? resolveUser(token) : Promise.resolve(null);
        // A public route can use IP identity without changing its auth behavior.
        resolution.catch(() => {});
        resolutions.set(req, resolution);
    }
    return resolutions.get(req);
};

const authenticate = (optional) => handle(async (req, res, next) => {
    const token = getBearerToken(req);
    if (!token) return optional ? next() : invalidToken();
    try {
        const user = await resolveRequestUser(req);
        if (!user) invalidToken();
        // A public endpoint may serve private data when an authenticated user is present.
        // Restricted sessions use the guest projection until they change their password.
        if (optional && user.must_change_password) return next();
        req.user = user;
        const authPath = req.originalUrl.split('?')[0];
        const canChangePassword = (req.method === 'GET' && authPath === '/api/auth/me')
            || (req.method === 'POST' && authPath === '/api/auth/change-password');
        if (!optional && user.must_change_password && !canChangePassword) {
            fail(403, 'Bạn cần đổi mật khẩu trước khi tiếp tục', 'PASSWORD_CHANGE_REQUIRED');
        }
        next();
    } catch (error) {
        if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) invalidToken();
        throw error;
    }
});

// Middleware xác thực JWT
const authenticateToken = authenticate(false);

const optionalAuthenticateToken = authenticate(true);

// Middleware kiểm tra quyền
const authorizeRoles = (...allowedRoles) => {
    return handle((req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            fail(403, 'Bạn không có quyền thực hiện hành động này', 'AUTH_FORBIDDEN');
        }
        next();
    });
};

module.exports = {
    authenticateToken,
    optionalAuthenticateToken,
    authorizeRoles,
    resolveRequestUser,
    resolveUser
};
