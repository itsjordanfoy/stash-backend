const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query } = require('../database/db');
const crypto = require('crypto');
const https = require('https');

const router = express.Router();

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

// POST /api/auth/register
router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('displayName').optional().trim().isLength({ max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, displayName } = req.body;

    try {
      const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const result = await query(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, subscription_status, imports_used, created_at`,
        [email, passwordHash, displayName || null]
      );

      const user = result.rows[0];
      const token = generateToken(user.id);

      res.status(201).json({ token, user });
    } catch (err) {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const result = await query(
        'SELECT id, email, password_hash, display_name, subscription_status, imports_used FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const { password_hash: _, ...safeUser } = user;
      const token = generateToken(user.id);
      res.json({ token, user: safeUser });
    } catch (err) {
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    const result = await query('SELECT id FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });

    const newToken = generateToken(decoded.userId);
    res.json({ token: newToken });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// POST /api/auth/apple
let appleKeysCache = { keys: null, fetchedAt: 0 };

async function fetchApplePublicKeys() {
  const now = Date.now();
  if (appleKeysCache.keys && now - appleKeysCache.fetchedAt < 3600_000) {
    return appleKeysCache.keys;
  }
  return new Promise((resolve, reject) => {
    https.get('https://appleid.apple.com/auth/keys', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const { keys } = JSON.parse(data);
          appleKeysCache = { keys, fetchedAt: Date.now() };
          resolve(keys);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function verifyAppleToken(identityToken) {
  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded) throw new Error('Invalid token');

  const keys = await fetchApplePublicKeys();
  const key = keys.find(k => k.kid === decoded.header.kid);
  if (!key) throw new Error('No matching Apple key');

  const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
  const payload = jwt.verify(identityToken, publicKey, {
    algorithms: ['RS256'],
    audience: process.env.APPLE_BUNDLE_ID || 'com.yourcompany.producttracker',
    issuer: 'https://appleid.apple.com',
  });
  return payload;
}

router.post('/apple', async (req, res) => {
  const { identityToken, displayName, email } = req.body;
  if (!identityToken) return res.status(400).json({ error: 'identityToken required' });

  try {
    const payload = await verifyAppleToken(identityToken);
    const appleId = payload.sub;

    // Check if user already exists by apple_id
    let result = await query(
      'SELECT id, email, display_name, subscription_status, imports_used FROM users WHERE apple_id = $1',
      [appleId]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
      const token = generateToken(user.id);
      return res.json({ token, user });
    }

    // New user — create account
    const resolvedEmail = email || payload.email || null;
    const result2 = await query(
      `INSERT INTO users (email, apple_id, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, subscription_status, imports_used, created_at`,
      [resolvedEmail, appleId, displayName || null]
    );

    const user = result2.rows[0];
    const token = generateToken(user.id);
    return res.status(201).json({ token, user });
  } catch (err) {
    console.error('[Auth] Apple sign-in error:', err.message);
    return res.status(401).json({ error: 'Apple sign-in failed' });
  }
});

// POST /api/auth/push-token
router.post('/push-token', require('../middleware/auth').authenticate, async (req, res) => {
  const { pushToken } = req.body;
  if (!pushToken) return res.status(400).json({ error: 'Push token required' });

  await query('UPDATE users SET push_token = $1 WHERE id = $2', [pushToken, req.user.id]);
  res.json({ success: true });
});

module.exports = router;
