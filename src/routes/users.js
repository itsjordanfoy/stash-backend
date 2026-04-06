const express = require('express');
const { query } = require('../database/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/users/me
router.get('/me', authenticate, async (req, res) => {
  const result = await query(
    `SELECT id, email, display_name, avatar_url, subscription_status,
            subscription_end_at, imports_used, created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
});

// PATCH /api/users/me
router.patch('/me', authenticate, async (req, res) => {
  const { displayName } = req.body;
  try {
    const result = await query(
      `UPDATE users SET display_name = COALESCE($1, display_name) WHERE id = $2
       RETURNING id, email, display_name, avatar_url, subscription_status, imports_used`,
      [displayName || null, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// GET /api/users/me/stats
router.get('/me/stats', authenticate, async (req, res) => {
  try {
    const [productCount, boardCount, latestPriceDrops, dropsToday, watchingValue] = await Promise.all([
      query('SELECT COUNT(*) FROM user_products WHERE user_id = $1', [req.user.id]),
      query('SELECT COUNT(*) FROM boards WHERE owner_id = $1', [req.user.id]),
      query(
        `SELECT p.name, p.image_url,
                ph.price as new_price,
                ph.retailer_name,
                ph.timestamp
         FROM price_history ph
         JOIN products p ON p.id = ph.product_id
         JOIN user_products up ON up.product_id = p.id
         WHERE up.user_id = $1
           AND ph.timestamp >= NOW() - INTERVAL '7 days'
         ORDER BY ph.timestamp DESC
         LIMIT 5`,
        [req.user.id]
      ),
      query(
        `SELECT COUNT(DISTINCT ph.product_id) as count
         FROM price_history ph
         JOIN user_products up ON up.product_id = ph.product_id
         WHERE up.user_id = $1
           AND ph.timestamp >= NOW() - INTERVAL '24 hours'`,
        [req.user.id]
      ),
      query(
        `SELECT COALESCE(SUM(pr.min_price), 0)::float as total
         FROM user_products up
         LEFT JOIN LATERAL (
           SELECT MIN(current_price)::float as min_price
           FROM product_retailers
           WHERE product_id = up.product_id AND current_price IS NOT NULL
         ) pr ON true
         WHERE up.user_id = $1 AND up.is_tracking = TRUE`,
        [req.user.id]
      ),
    ]);

    res.json({
      product_count: parseInt(productCount.rows[0].count),
      board_count: parseInt(boardCount.rows[0].count),
      recent_price_changes: latestPriceDrops.rows,
      drops_today: parseInt(dropsToday.rows[0].count),
      watching_value: parseFloat(watchingValue.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;
