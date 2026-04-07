const express = require('express');
const { query } = require('../database/db');
const { authenticate } = require('../middleware/auth');
const { reExtractProduct } = require('../services/importService');

const router = express.Router();

// ── Filter-tag helpers (mirrors Swift filterTag computed property) ─────────────
function computeFilterTag(product) {
  const cat  = (product.category || '').toLowerCase();
  const gen  = (product.genre    || '').toLowerCase();
  const name = (product.name     || '').toLowerCase();
  const type = product.item_type || '';

  if (type === 'event') return 'Events';
  if (type === 'place') return 'Places';
  if (type === 'general' && product.ingredients) return 'Recipes';

  const has = (words, ...fields) => words.some(w => fields.some(f => f.includes(w)));

  const clothingWords = ['cloth','apparel','fashion','streetwear','shirt','tee','hoodie',
    'jacket','coat','denim','jeans','shoe','sneaker','trainer','boot','hat','cap'];
  if (has(clothingWords, cat, name)) return 'Clothing';

  const musicWords = ['music','vinyl','album','single',' ep','hip-hop','hip hop','r&b',
    'rnb','rock','jazz','pop','electronic','soul','classical','folk','metal','punk',
    'reggae','country','blues','rap','record','soundtrack','discograph'];
  if (has(musicWords, cat, gen)) return 'Music';

  const electronicsWords = ['electron','tech','computer','laptop','tablet','phone',
    'headphone','earphone','earbud','speaker','audio','camera','photo','lens',
    'dslr','mirrorless','projector','monitor','keyboard','console','gaming','wearable','smartwatch'];
  if (has(electronicsWords, cat, name)) return 'Electronics';

  const homeWords = ['furniture','kitchen','bedroom','bathroom','garden','lighting','bedding','cookware',
    'paint','decor','interior','curtain','rug','carpet','wallpaper','candle','storage','shelf','shelving'];
  if (has(homeWords, cat, name)) return 'Home';

  const beautyWords = ['beauty','skincare','fragrance','perfume','makeup','cosmetic','grooming','haircare','nail'];
  if (has(beautyWords, cat, name)) return 'Beauty';

  const sportsWords = ['sport','fitness','gym','cycling','running','yoga','hiking','climbing','golf','tennis'];
  if (has(sportsWords, cat, name)) return 'Sports';

  const foodWords = ['food','drink','grocery','beverage','wine','coffee','tea','spirits','snack','condiment'];
  if (has(foodWords, cat, name)) return 'Food & Drink';

  const bookWords = ['book','novel','fiction','non-fiction','biography','memoir','poetry','literature','publishing'];
  if (has(bookWords, cat, name) || type === 'book') return 'Books';

  const entertainmentWords = ['film','movie','cinema','animation','anime','cartoon','kids','family',
    'drama','thriller','horror','documentary','sci-fi','action','adventure','comedy','fantasy',
    'series','tv show','television','streaming','superhero','mystery','western'];
  if (type === 'entertainment' || has(entertainmentWords, cat, gen)) return 'Movies & TV';

  if (type === 'general') return product.category || 'Saved';
  return product.category || 'Saved';
}

const FILTER_TAG_EMOJI = {
  'Events':       '🎟️',
  'Places':       '📍',
  'Recipes':      '🍽️',
  'Clothing':     '👗',
  'Music':        '🎵',
  'Electronics':  '💻',
  'Home':         '🏠',
  'Beauty':       '💄',
  'Sports':       '🏃',
  'Food & Drink': '☕',
  'Books':        '📚',
  'Movies & TV':  '🎬',
};

// GET /api/products/recent?limit=20&offset=0&sort=recent
router.get('/recent', authenticate, async (req, res) => {
  const { limit = 20, offset = 0, sort = 'recent' } = req.query;

  const sortClause = {
    recent:     'up.created_at DESC',
    price_asc:  'pr.current_price ASC NULLS LAST, up.created_at DESC',
    price_desc: 'pr.current_price DESC NULLS LAST, up.created_at DESC',
  }[sort] || 'up.created_at DESC';

  try {
    const [result, countResult] = await Promise.all([
      query(
        `SELECT p.id, p.name, p.brand, p.image_url, p.category,
                pr.current_price::float as lowest_price, pr.currency,
                up.source_type, up.is_tracking, up.created_at as saved_at
         FROM products p
         JOIN user_products up ON up.product_id = p.id
         LEFT JOIN LATERAL (
           SELECT current_price, currency
           FROM product_retailers
           WHERE product_id = p.id AND current_price IS NOT NULL
           ORDER BY current_price ASC LIMIT 1
         ) pr ON true
         WHERE up.user_id = $1
         ORDER BY ${sortClause}
         LIMIT $2 OFFSET $3`,
        [req.user.id, parseInt(limit), parseInt(offset)]
      ),
      query('SELECT COUNT(*) FROM user_products WHERE user_id = $1', [req.user.id]),
    ]);
    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    res.json({ products: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load recent products' });
  }
});

// GET /api/products/search?q=...
router.get('/search', authenticate, async (req, res) => {
  const { q, limit = 20, offset = 0 } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  try {
    // Full-text + trigram search across user's saved products
    const result = await query(
      `SELECT DISTINCT p.id, p.name, p.brand, p.image_url, p.category,
              pr.current_price::float, pr.currency,
              up.source_type, up.created_at as saved_at,
              ts_rank(p.search_vector, plainto_tsquery('english', $1)) AS rank
       FROM products p
       JOIN user_products up ON up.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT current_price, currency
         FROM product_retailers
         WHERE product_id = p.id AND current_price IS NOT NULL
         ORDER BY current_price ASC
         LIMIT 1
       ) pr ON true
       WHERE up.user_id = $2
         AND (
           p.search_vector @@ plainto_tsquery('english', $1)
           OR p.name ILIKE $3
           OR p.brand ILIKE $3
         )
       ORDER BY rank DESC, up.created_at DESC
       LIMIT $4 OFFSET $5`,
      [q, req.user.id, `%${q}%`, limit, offset]
    );

    res.json({ products: result.rows, total: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/products/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [productResult, retailersResult, historyResult, alternativesResult] =
      await Promise.all([
        query(
          `SELECT p.*,
                  p.runtime, p.content_rating, p.cast_members, p.trailer_url,
                  p.page_count, p.publisher, p.edition, p.goodreads_url,
                  p.tracklist, p.record_label, p.pressing_info, p.condition,
                  p.specs,
                  p.latitude, p.longitude, p.opening_hours, p.reservation_url,
                  p.servings, p.cook_time,
                  p.imdb_score, p.rotten_tomatoes_score, p.awards, p.streaming_links, p.cast_with_photos,
                  p.book_editions, p.book_awards, p.tour_dates, p.spotify_url, p.apple_music_url,
                  p.price_range, p.menu_url, p.weather_forecast, p.nutrition, p.difficulty,
                  up.source_url, up.source_type, up.screenshot_url,
                  up.is_tracking, up.notes, up.created_at as saved_at, up.price_target,
                  up.current_page, up.checked_ingredients, up.size_preference, up.colour_preference
           FROM products p
           JOIN user_products up ON up.product_id = p.id
           WHERE p.id = $1 AND up.user_id = $2`,
          [req.params.id, req.user.id]
        ),
        query(
          `SELECT id, retailer_name, product_url, current_price::float, currency, in_stock, last_checked, is_discontinued
           FROM product_retailers
           WHERE product_id = $1
           ORDER BY current_price ASC NULLS LAST`,
          [req.params.id]
        ),
        query(
          `SELECT price::float, retailer_name, currency, timestamp
           FROM price_history
           WHERE product_id = $1
           ORDER BY timestamp ASC
           LIMIT 90`,
          [req.params.id]
        ),
        query(
          `SELECT p.id, p.name, p.brand, p.image_url, pa.reason,
                  pa.similarity_score::float AS similarity_score,
                  (SELECT MIN(current_price)::float FROM product_retailers WHERE product_id = p.id) AS lowest_price
           FROM product_alternatives pa
           JOIN products p ON p.id = pa.alternative_id
           WHERE pa.product_id = $1
           ORDER BY pa.similarity_score DESC
           LIMIT 6`,
          [req.params.id]
        ),
      ]);

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productResult.rows[0];
    const prices = historyResult.rows.map(r => r.price);

    // Fallback: derive lowest_price from retailers if not on the product row
    const lowestRetailerPrice = retailersResult.rows.reduce((min, r) => {
      if (r.current_price == null) return min;
      return min === null ? r.current_price : Math.min(min, r.current_price);
    }, null);

    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    res.json({
      ...product,
      lowest_price: product.lowest_price ?? lowestRetailerPrice,
      retailers: retailersResult.rows,
      price_history: historyResult.rows,
      lowest_price_ever: prices.length > 0 ? Math.min(...prices) : null,
      alternatives: alternativesResult.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// PATCH /api/products/:id/notes
router.patch('/:id/notes', authenticate, async (req, res) => {
  const { notes } = req.body;
  try {
    await query(
      'UPDATE user_products SET notes = $1 WHERE product_id = $2 AND user_id = $3',
      [notes, req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update notes' });
  }
});

// PATCH /api/products/:id/reading-progress
router.patch('/:id/reading-progress', authenticate, async (req, res) => {
  const { current_page } = req.body;
  if (current_page === undefined || current_page === null || !Number.isInteger(current_page) || current_page < 0) {
    return res.status(400).json({ error: 'current_page must be a non-negative integer' });
  }
  try {
    await query(
      'UPDATE user_products SET current_page = $1 WHERE product_id = $2 AND user_id = $3',
      [current_page, req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update reading progress' });
  }
});

// PATCH /api/products/:id/checked-ingredients
router.patch('/:id/checked-ingredients', authenticate, async (req, res) => {
  const { checked_ingredients } = req.body;
  if (!Array.isArray(checked_ingredients)) {
    return res.status(400).json({ error: 'checked_ingredients must be an array of booleans' });
  }
  try {
    await query(
      'UPDATE user_products SET checked_ingredients = $1 WHERE product_id = $2 AND user_id = $3',
      [JSON.stringify(checked_ingredients), req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update checked ingredients' });
  }
});

// PATCH /api/products/:id/clothing-preference
router.patch('/:id/clothing-preference', authenticate, async (req, res) => {
  const { size_preference, colour_preference } = req.body;
  if (size_preference === undefined && colour_preference === undefined) {
    return res.status(400).json({ error: 'Provide at least one of size_preference or colour_preference' });
  }
  try {
    await query(
      `UPDATE user_products
       SET size_preference   = COALESCE($1, size_preference),
           colour_preference = COALESCE($2, colour_preference)
       WHERE product_id = $3 AND user_id = $4`,
      [size_preference ?? null, colour_preference ?? null, req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update clothing preference' });
  }
});

// POST /api/products/:id/find-retailers
router.post('/:id/find-retailers', authenticate, async (req, res) => {
  try {
    const productResult = await query(
      'SELECT id, name, brand, category FROM products WHERE id = $1',
      [req.params.id]
    );
    if (!productResult.rows[0]) return res.status(404).json({ error: 'Product not found' });

    // Verify user has access
    const access = await query(
      'SELECT id FROM user_products WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.id]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Access denied' });

    // Throttle: skip if already searched in the last 24 hours
    const throttleResult = await query(
      'SELECT last_retailer_search_at FROM products WHERE id = $1',
      [req.params.id]
    );
    const lastSearch = throttleResult.rows[0]?.last_retailer_search_at;
    if (lastSearch && (Date.now() - new Date(lastSearch).getTime()) < 24 * 60 * 60 * 1000) {
      return res.json({ found: 0, retailers: [], skipped: true });
    }

    const product = productResult.rows[0];
    const { findRetailersForProduct } = require('../services/aiService');
    const { scrapeRetailerPrice, isSameProduct } = require('../services/scraperService');

    const suggestions = await findRetailersForProduct(product);
    const found = [];

    await Promise.allSettled(
      suggestions.map(async suggestion => {
        if (!suggestion.url || !suggestion.retailer_name) return;
        try {
          const priceData = await scrapeRetailerPrice(suggestion.url);
          if (!priceData?.price) return;

          // Reject if the page is not the exact same product
          if (!isSameProduct(product.name, product.brand, priceData.pageTitle)) return;

          await query(
            `INSERT INTO product_retailers (product_id, retailer_name, product_url, current_price, currency, in_stock)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (product_id, product_url) DO UPDATE
               SET current_price = EXCLUDED.current_price,
                   in_stock = EXCLUDED.in_stock,
                   last_checked = NOW()`,
            [product.id, suggestion.retailer_name, suggestion.url, priceData.price, priceData.currency || 'GBP', priceData.in_stock]
          );
          found.push({
            retailer_name: suggestion.retailer_name,
            url: suggestion.url,
            price: priceData.price,
            currency: priceData.currency || 'GBP',
            in_stock: priceData.in_stock,
          });
        } catch { /* skip failed retailers */ }
      })
    );

    // Record that we searched so we don't spam the AI + scraper
    await query('UPDATE products SET last_retailer_search_at = NOW() WHERE id = $1', [req.params.id]);

    res.json({ found: found.length, retailers: found });
  } catch (err) {
    res.status(500).json({ error: 'Failed to find retailers' });
  }
});

// POST /api/products/:id/auto-board
// Assigns the product to the best-matching board.
// Priority: 1) exact name match on filterTag  2) create a new board with that name.
// Always succeeds — a stash is always created/assigned on import.
router.post('/:id/auto-board', authenticate, async (req, res) => {
  try {
    const productResult = await query(
      `SELECT p.id, p.name, p.brand, p.category, p.genre, p.item_type, p.ingredients
       FROM products p
       JOIN user_products up ON up.product_id = p.id
       WHERE p.id = $1 AND up.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (productResult.rows.length === 0) return res.json({ board: null });
    const product = productResult.rows[0];

    const targetName = computeFilterTag(product);
    const targetEmoji = FILTER_TAG_EMOJI[targetName] || '📦';

    // Fetch existing boards
    const boardsResult = await query(
      `SELECT id, name, emoji FROM boards WHERE owner_id = $1`,
      [req.user.id]
    );
    const boards = boardsResult.rows;

    // 1. Exact name match (case-insensitive)
    let board = boards.find(b => b.name.toLowerCase() === targetName.toLowerCase());

    // 2. No match — create a new board named after the filterTag
    if (!board) {
      const created = await query(
        `INSERT INTO boards (name, emoji, owner_id)
         VALUES ($1, $2, $3)
         RETURNING id, name, emoji`,
        [targetName, targetEmoji, req.user.id]
      );
      board = created.rows[0];
    }

    // Assign product to board
    await query(
      `INSERT INTO board_items (board_id, product_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (board_id, product_id) DO NOTHING`,
      [board.id, req.params.id, req.user.id]
    );

    res.json({ board: { id: board.id, name: board.name, emoji: board.emoji || null } });
  } catch (err) {
    console.error('auto-board error:', err.message);
    res.json({ board: null });
  }
});


// POST /api/products/:id/recategorize — re-extract with a corrected category hint
router.post('/:id/recategorize', authenticate, async (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: 'category is required' });

  try {
    await reExtractProduct(req.params.id, req.user.id, category);
    // Return the freshly updated product using the existing fetch query
    const result = await query(
      `SELECT p.*, up.source_url, up.source_type, up.notes, up.is_tracking,
              up.current_page, up.checked_ingredients, up.size_preference, up.colour_preference,
              up.saved_at,
              COALESCE(json_agg(DISTINCT jsonb_build_object(
                'id', pr.id, 'retailer_name', pr.retailer_name, 'product_url', pr.product_url,
                'current_price', pr.current_price, 'currency', pr.currency,
                'in_stock', pr.in_stock, 'last_checked', pr.last_checked
              )) FILTER (WHERE pr.id IS NOT NULL), '[]') AS retailers
       FROM products p
       JOIN user_products up ON up.product_id = p.id
       LEFT JOIN product_retailers pr ON pr.product_id = p.id
       WHERE p.id = $1 AND up.user_id = $2
       GROUP BY p.id, up.source_url, up.source_type, up.notes, up.is_tracking,
                up.current_page, up.checked_ingredients, up.size_preference, up.colour_preference,
                up.saved_at`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Recategorize error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/products/:id  (removes from user's library, not globally)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await query(
      'DELETE FROM user_products WHERE product_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove product' });
  }
});

module.exports = router;
