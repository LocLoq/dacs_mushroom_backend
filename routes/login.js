const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { auditAction } = require('../middlewares/audit');
const { authenticateToken } = require('../middlewares/auth');


const router = express.Router();
const prisma = global.prisma;

router.post('/login', auditAction('LOGIN', {
  entityType: 'User',
  metadata: (req) => ({ username: req.body?.username || null })
}), async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = await prisma.user.findUnique({
      where: { username },
      include: { role: true }
    });

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    let isPasswordValid = false;
    
    // Check if it's bcrypt hash
    if (user.password_hash && user.password_hash.startsWith('$2')) {
       isPasswordValid = await bcrypt.compare(password, user.password_hash);
    } else {
       // Plaintext fallback
       isPasswordValid = (password === user.password_hash);
    }

    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const payload = {
      id: user.id,
      username: user.username,
      role: user.role.name,
      tokenver: user.tokenver
    };

    res.locals.auditActor = payload;

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '2h' });

    res.json({ message: 'Login successful', token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, username: true, full_name: true, email: true, phone_number: true,
        role: { select: { name: true } }
      }
    });
    if (!user || !user.role || !global.allRoles.includes(user.role.name)) {
      return res.status(401).json({ code: 'AUTH_INVALID_TOKEN', message: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ' });
    }
    res.json({ data: { id: user.id, username: user.username, full_name: user.full_name, role: user.role.name, email: user.email, phone_number: user.phone_number } });
  } catch (error) {
    console.error('Auth me error:', error);
    res.status(500).json({ message: 'Lỗi máy chủ' });
  }
});

module.exports = router;
