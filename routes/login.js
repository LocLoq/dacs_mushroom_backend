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
      must_change_password: true, role: { select: { name: true } }
    }
  });
  if (!user || !user.role || !global.allRoles.includes(user.role.name)) {
    fail(401, 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ', 'AUTH_INVALID_TOKEN');
  }
  res.json({ data: { id: user.id, username: user.username, full_name: user.full_name, role: user.role.name, email: user.email, phone_number: user.phone_number, must_change_password: user.must_change_password === true } });
}));

router.post('/auth/change-password', auditAction('PASSWORD_CHANGE', { entityType: 'User', entityId: (req) => String(req.user?.id || '') }), authenticateToken, handle(async (req, res) => {
  fields(req.body, ['current_password', 'new_password']);
  const { current_password, new_password } = req.body;
  if (typeof current_password !== 'string' || !current_password.length || typeof new_password !== 'string' || !new_password.length) fail(400, 'Mật khẩu không hợp lệ');
  if (new_password === current_password) fail(400, 'Mật khẩu mới phải khác mật khẩu hiện tại');
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user || user.tokenver !== req.user.tokenver) fail(401, 'Phiên đăng nhập không hợp lệ', 'AUTH_INVALID_TOKEN');
  const matches = user.password_hash.startsWith('$2') ? await bcrypt.compare(current_password, user.password_hash) : current_password === user.password_hash;
  if (!matches) fail(400, 'Mật khẩu hiện tại không đúng');
  const password_hash = await bcrypt.hash(new_password, 10);
  const updated = await prisma.$transaction(async (tx) => {
    // Compare token version as well: a concurrent admin reset must not be overwritten.
    const result = await tx.user.updateMany({ where: { id: user.id, tokenver: user.tokenver }, data: { password_hash, must_change_password: false, tokenver: { increment: 1 } } });
    if (result.count !== 1) fail(409, 'Tài khoản đã thay đổi; vui lòng đăng nhập lại', 'STATE_CONFLICT');
    return tx.user.findUnique({ where: { id: user.id }, include: { role: { select: { name: true } } } });
  });
  const token = jwt.sign({ id: updated.id, username: updated.username, role: updated.role.name, tokenver: updated.tokenver }, process.env.JWT_SECRET, { expiresIn: '2h' });
  res.json({ message: 'Đổi mật khẩu thành công', token, data: { id: updated.id, username: updated.username, full_name: updated.full_name, email: updated.email, phone_number: updated.phone_number, role: updated.role.name, must_change_password: false } });
}));

module.exports = router;
