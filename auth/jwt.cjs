const jwt = require('jsonwebtoken');

const authenticateJWT = async (req, res, next) => {
  // Get auth header - The Authorization header is commonly used to send authentication tokens
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }

  // Extract token from "Bearer <token>"
  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Token missing' });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user to request and check if the password is changed
    req.user = decoded;
    const user = await global.prisma.user.findUnique({
      where: { username: decoded.username},
      include: { role: true }
    });

    if (decoded.tokenver < user.tokenver) {
      throw 
    }

    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

module.exports = { authenticateJWT };