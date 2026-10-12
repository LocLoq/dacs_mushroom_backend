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
    return { id: user.id, username: user.username, role: user.role.name, tokenver: user.tokenver };
};

const authenticate = (optional) => handle(async (req, res, next) => {
    const token = getBearerToken(req);
    if (!token) return optional ? next() : invalidToken();
    try {
        const user = await resolveUser(token);
        if (!user) invalidToken();
        req.user = user;
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
    authorizeRoles
};
