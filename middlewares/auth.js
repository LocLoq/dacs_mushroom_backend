const jwt = require('jsonwebtoken');

// Middleware xác thực JWT
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ message: 'Không tìm thấy token' });
    
    jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
        if (err) return res.status(403).json({ message: 'Token không hợp lệ hoặc đã hết hạn' });

        // Attach user to request and check if the password is changed
        req.user = decodedUser;
        const user = await global.prisma.user.findUnique({
            where: { username: decoded.username},
            include: { role: true }
        });
        
        if (decodedUser.tokenver < user.tokenver) {
            return res.status(403).json({ message: 'Token không hợp lệ hoặc đã hết hạn' });
        }
        next();
    });
};

// Middleware kiểm tra quyền
const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Bạn không có quyền thực hiện hành động này' });
        }
        next();
    };
};

module.exports = {
    authenticateToken,
    authorizeRoles
};

