const jwt = require('jsonwebtoken');

// Middleware xác thực JWT
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ message: 'Không tìm thấy token' });
    
    jwt.verify(token, process.env.JWT_SECRET, async (err, decodedUser) => {
        if (err) return res.status(403).json({ message: 'Token không hợp lệ hoặc đã hết hạn' });

        try {
            const dbUser = await global.prisma.user.findUnique({
                where: { username: decodedUser.username}
            });
            
            if (!dbUser || decodedUser.tokenver < dbUser.tokenver) {
                return res.status(403).json({ message: 'Token không hợp lệ hoặc đã hết hạn' });
            }
            
            req.user = decodedUser;
            next();
        } catch (dbErr) {
            console.error(dbErr);
            return res.status(500).json({ message: 'Lỗi xác thực người dùng' });
        }
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

