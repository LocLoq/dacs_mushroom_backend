const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');


const router = express.Router();
const prisma = global.prisma;

router.post('/login', async (req, res) => {
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

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '2h' });

    res.json({ message: 'Login successful', token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;