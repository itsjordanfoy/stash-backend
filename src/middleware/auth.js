const jwt = require('jsonwebtoken');
const { query } = require('../database/db');

/**
 * Verify the JWT token only — no database round-trip.
 * Sets req.user = { id } from the token payload.
 * Use on all routes that only need the user's identity.
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.userId };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Fetch full user record from DB.
 * Chain after authenticate only on routes that need
 * subscription_status, imports_used, or email.
 */
async function loadUserData(req, res, next) {
  try {
    const result = await query(
      'SELECT id, email, subscription_status, imports_used FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Authentication error' });
  }
}

function requirePaid(req, res, next) {
  if (req.user.subscription_status !== 'paid') {
    return res.status(403).json({
      error: 'This feature requires a paid subscription',
      code: 'SUBSCRIPTION_REQUIRED',
    });
  }
  next();
}

function checkImportLimit(req, res, next) {
  const FREE_LIMIT = 5;
  if (
    req.user.subscription_status === 'free' &&
    req.user.imports_used >= FREE_LIMIT
  ) {
    return res.status(403).json({
      error: 'Free plan import limit reached',
      code: 'IMPORT_LIMIT_REACHED',
      limit: FREE_LIMIT,
      used: req.user.imports_used,
    });
  }
  next();
}

module.exports = { authenticate, loadUserData, requirePaid, checkImportLimit };
