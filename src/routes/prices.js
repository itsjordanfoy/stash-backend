const express = require('express');
const { query } = require('../database/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/prices/:productId/history
router.get('/:productId/history', authenticate, async (req, res) => {
  const { days = 90 } = req.query;

  try {
    // Verify user has access to this product
    const access = await query(
      'SELECT id FROM user_products WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.productId]
    );
    if (access.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const result = await query(
      `SELECT price, retailer_name, currency, timestamp
       FROM price_history
       WHERE product_id = $1
         AND timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
       ORDER BY timestamp ASC`,
      [req.params.productId]
    );

    const prices = result.rows.map(r => r.price);
    const lowestEver = await query(
      'SELECT MIN(price) as lowest FROM price_history WHERE product_id = $1',
      [req.params.productId]
    );

    res.json({
      history: result.rows,
      lowest_ever: lowestEver.rows[0]?.lowest || null,
      current_low: prices.length > 0 ? Math.min(...prices) : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load price history' });
  }
});

// GET /api/prices/:productId/retailers
router.get('/:productId/retailers', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, retailer_name, product_url, current_price, currency, in_stock, last_checked
       FROM product_retailers
       WHERE product_id = $1
       ORDER BY current_price ASC NULLS LAST`,
      [req.params.productId]
    );
    res.json({ retailers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load retailers' });
  }
});

// POST /api/prices/:productId/refresh — user-triggered immediate price check
router.post('/:productId/refresh', authenticate, async (req, res) => {
  try {
    const access = await query(
      'SELECT id FROM user_products WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.productId]
    );
    if (access.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    const { checkProductPricesNow } = require('../jobs/priceTracker');
    // Run in background — respond immediately so the client isn't waiting
    checkProductPricesNow(req.params.productId).catch(() => {});

    res.json({ success: true, message: 'Price refresh started' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start price refresh' });
  }
});

// POST /api/prices/:productId/track — enable daily tracking
router.post('/:productId/track', authenticate, async (req, res) => {
  try {
    await query(
      'UPDATE user_products SET is_tracking = TRUE WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.productId]
    );
    res.json({ success: true, tracking: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to enable tracking' });
  }
});

// DELETE /api/prices/:productId/track — disable daily tracking
router.delete('/:productId/track', authenticate, async (req, res) => {
  try {
    await query(
      'UPDATE user_products SET is_tracking = FALSE WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.productId]
    );
    res.json({ success: true, tracking: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disable tracking' });
  }
});

// PATCH /api/prices/:productId/target — set or clear a price target
router.patch('/:productId/target', authenticate, async (req, res) => {
  const { target_price } = req.body;
  try {
    const access = await query(
      'SELECT id FROM user_products WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.productId]
    );
    if (access.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    const value = (target_price !== undefined && target_price !== null && !isNaN(parseFloat(target_price)))
      ? parseFloat(target_price)
      : null;

    await query(
      'UPDATE user_products SET price_target = $1 WHERE user_id = $2 AND product_id = $3',
      [value, req.user.id, req.params.productId]
    );
    res.json({ success: true, price_target: value });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update price target' });
  }
});

module.exports = router;
