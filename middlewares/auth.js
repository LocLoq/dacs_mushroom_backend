const jwt = require('jsonwebtoken');

const invalidToken = (res) => res.status(401).json({
    code: 'AUTH_INVALID_TOKEN',
    message: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ'
});

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

const authenticate = async (req, res, next, optional) => {
    const token = getBearerToken(req);
    if (!token) return optional ? next() : invalidToken(res);
    try {
        const user = await resolveUser(token);
        if (!user) return invalidToken(res);
        req.user = user;
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') return invalidToken(res);
        console.error(error);
        return res.status(500).json({ message: 'Lỗi xác thực người dùng' });
    }
};

// Middleware xác thực JWT
const authenticateToken = async (req, res, next) => {
    return authenticate(req, res, next, false);
};

const optionalAuthenticateToken = async (req, res, next) => {
    return authenticate(req, res, next, true);
};

// Middleware kiểm tra quyền
const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ code: 'AUTH_FORBIDDEN', message: 'Bạn không có quyền thực hiện hành động này' });
        }
        next();
    };
};

module.exports = {
    authenticateToken,
    optionalAuthenticateToken,
    authorizeRoles
};
