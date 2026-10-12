const { fail, fields, textField, handle } = require('../services/apiHelpers');
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
}), handle(async (req, res) => {
  fields(req.body, ['username', 'password']);
  const { username, password } = req.body;
  textField(username, 'username', 50);
  if (typeof password !== 'string' || !password.length) fail(400, 'password không hợp lệ');

  const user = await prisma.user.findUnique({
    where: { username },
    include: { role: true }
  });

  if (!user) {
    fail(401, 'Invalid credentials');
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
    fail(401, 'Invalid credentials');
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
}));

router.get('/auth/me', authenticateToken, handle(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, username: true, full_name: true, email: true, phone_number: true,
      role: { select: { name: true } }
    }
  });
  if (!user || !user.role || !global.allRoles.includes(user.role.name)) {
    fail(401, 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ', 'AUTH_INVALID_TOKEN');
  }
  res.json({ data: { id: user.id, username: user.username, full_name: user.full_name, role: user.role.name, email: user.email, phone_number: user.phone_number } });
}));

module.exports = router;
