const express = require('express');
const { query } = require('../database/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Shared CASE expression — mirrors the Swift filterTag logic exactly.
// Music is NOT gated on item_type='entertainment' so vinyl records (item_type=product) resolve correctly.
const FILTER_TAG_CASE = `
  CASE
    WHEN p.item_type = 'event' THEN 'Events'
    WHEN p.item_type = 'place' THEN 'Places'
    WHEN p.item_type = 'general' AND p.ingredients IS NOT NULL THEN 'Recipes'
    WHEN p.category ILIKE '%cloth%' OR p.category ILIKE '%fashion%' OR p.category ILIKE '%apparel%'
      OR p.category ILIKE '%shirt%' OR p.category ILIKE '%hoodie%' OR p.category ILIKE '%jacket%'
      OR p.category ILIKE '%denim%' OR p.category ILIKE '%shoe%' OR p.category ILIKE '%sneaker%'
      OR p.name ILIKE '%shirt%' OR p.name ILIKE '%hoodie%' OR p.name ILIKE '%jacket%'
      OR p.name ILIKE '%sneaker%' OR p.name ILIKE '%trainer%' THEN 'Clothing'
    WHEN p.category ILIKE '%music%' OR p.category ILIKE '%vinyl%' OR p.category ILIKE '%album%'
      OR p.category ILIKE '%record%' OR p.category ILIKE '%soundtrack%' OR p.category ILIKE '%discograph%'
      OR p.genre ILIKE '%music%' OR p.genre ILIKE '%hip%' OR p.genre ILIKE '%rock%'
      OR p.genre ILIKE '%jazz%' OR p.genre ILIKE '%pop%' OR p.genre ILIKE '%r&b%'
      OR p.genre ILIKE '%electronic%' OR p.genre ILIKE '%soul%' OR p.genre ILIKE '%classical%'
      OR p.genre ILIKE '%folk%' OR p.genre ILIKE '%metal%' OR p.genre ILIKE '%punk%'
      OR p.genre ILIKE '%reggae%' OR p.genre ILIKE '%blues%' OR p.genre ILIKE '%rap%' THEN 'Music'
    WHEN p.item_type = 'entertainment'
      OR p.category ILIKE '%film%' OR p.category ILIKE '%movie%' OR p.category ILIKE '%cinema%'
      OR p.category ILIKE '%animation%' OR p.category ILIKE '%anime%' OR p.category ILIKE '%cartoon%'
      OR p.category ILIKE '%kids%' OR p.category ILIKE '%family%' OR p.category ILIKE '%drama%'
      OR p.category ILIKE '%thriller%' OR p.category ILIKE '%horror%' OR p.category ILIKE '%documentary%'
      OR p.category ILIKE '%sci-fi%' OR p.category ILIKE '%action%' OR p.category ILIKE '%adventure%'
      OR p.category ILIKE '%comedy%' OR p.category ILIKE '%fantasy%' OR p.category ILIKE '%series%'
      OR p.category ILIKE '%tv show%' OR p.category ILIKE '%television%' OR p.category ILIKE '%streaming%'
      OR p.category ILIKE '%superhero%' OR p.category ILIKE '%mystery%' OR p.category ILIKE '%western%'
      OR p.genre ILIKE '%animation%' OR p.genre ILIKE '%kids%' OR p.genre ILIKE '%family%'
      OR p.genre ILIKE '%drama%' OR p.genre ILIKE '%comedy%' OR p.genre ILIKE '%action%'
      OR p.genre ILIKE '%thriller%' OR p.genre ILIKE '%horror%' OR p.genre ILIKE '%fantasy%'
      OR p.genre ILIKE '%documentary%' OR p.genre ILIKE '%sci-fi%' THEN 'Movies & TV'
    WHEN p.category ILIKE '%electron%' OR p.category ILIKE '%tech%' OR p.category ILIKE '%audio%'
      OR p.category ILIKE '%camera%' OR p.category ILIKE '%photo%' OR p.category ILIKE '%lens%'
      OR p.category ILIKE '%dslr%' OR p.category ILIKE '%mirrorless%' OR p.category ILIKE '%optic%'
      OR p.category ILIKE '%headphone%' OR p.category ILIKE '%phone%' OR p.category ILIKE '%projector%'
      OR p.category ILIKE '%speaker%' OR p.category ILIKE '%console%' OR p.category ILIKE '%gaming%'
      OR p.name ILIKE '%camera%' OR p.name ILIKE '%photo%' OR p.name ILIKE '%lens%'
      OR p.name ILIKE '%mirrorless%' OR p.name ILIKE '%dslr%' THEN 'Electronics'
    WHEN p.category ILIKE '%home%' OR p.category ILIKE '%furniture%' OR p.category ILIKE '%kitchen%'
      OR p.category ILIKE '%bedroom%' OR p.category ILIKE '%garden%' OR p.category ILIKE '%lighting%'
      OR p.name ILIKE '%furniture%' OR p.name ILIKE '%cookware%' THEN 'Home'
    WHEN p.category ILIKE '%beauty%' OR p.category ILIKE '%skincare%' OR p.category ILIKE '%fragrance%'
      OR p.category ILIKE '%makeup%' OR p.category ILIKE '%grooming%' OR p.category ILIKE '%haircare%'
      OR p.name ILIKE '%perfume%' OR p.name ILIKE '%cologne%' THEN 'Beauty'
    WHEN p.category ILIKE '%sport%' OR p.category ILIKE '%fitness%' OR p.category ILIKE '%gym%'
      OR p.category ILIKE '%cycling%' OR p.category ILIKE '%running%' OR p.category ILIKE '%yoga%'
      OR p.category ILIKE '%hiking%' OR p.category ILIKE '%golf%' OR p.category ILIKE '%tennis%' THEN 'Sports'
    WHEN p.category ILIKE '%food%' OR p.category ILIKE '%drink%' OR p.category ILIKE '%wine%'
      OR p.category ILIKE '%coffee%' OR p.category ILIKE '%grocery%' OR p.category ILIKE '%beverage%'
      OR p.category ILIKE '%spirits%' OR p.category ILIKE '%tea%' THEN 'Food & Drink'
    ELSE p.category
  END`;

// GET /api/search/categories  — filter tags for the user's collection
router.get('/categories', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT
         (${FILTER_TAG_CASE}) AS tag,
         COUNT(*)::int AS cnt
       FROM products p
       JOIN user_products up ON up.product_id = p.id
       WHERE up.user_id = $1
         AND (p.item_type IS NOT NULL OR p.category IS NOT NULL)
       GROUP BY tag
       HAVING (${FILTER_TAG_CASE}) IS NOT NULL
       ORDER BY cnt DESC
       LIMIT 20`,
      [req.user.id]
    );
    const tags = [...new Set(result.rows.map(r => r.tag).filter(Boolean))];
    res.json({ categories: tags });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// Resolve a filter tag into a SQL WHERE condition.
// Mirrors the Swift filterTag logic — Music is not gated on item_type.
function tagCondition(tag) {
  const musicCat = `(
    p.category ILIKE '%music%' OR p.category ILIKE '%vinyl%' OR p.category ILIKE '%album%'
    OR p.category ILIKE '%record%' OR p.category ILIKE '%soundtrack%' OR p.category ILIKE '%discograph%'
    OR p.genre ILIKE '%music%' OR p.genre ILIKE '%hip%' OR p.genre ILIKE '%rock%'
    OR p.genre ILIKE '%jazz%' OR p.genre ILIKE '%pop%' OR p.genre ILIKE '%r&b%'
    OR p.genre ILIKE '%electronic%' OR p.genre ILIKE '%soul%' OR p.genre ILIKE '%classical%'
    OR p.genre ILIKE '%folk%' OR p.genre ILIKE '%metal%' OR p.genre ILIKE '%punk%'
    OR p.genre ILIKE '%reggae%' OR p.genre ILIKE '%blues%' OR p.genre ILIKE '%rap%'
  )`;
  switch (tag) {
    case 'Events':     return "p.item_type = 'event'";
    case 'Places':     return "p.item_type = 'place'";
    case 'Recipes':    return "p.item_type = 'general' AND p.ingredients IS NOT NULL";
    case 'Music':      return musicCat;
    case 'Movies & TV': return `(
      p.item_type = 'entertainment'
      OR p.category ILIKE '%film%' OR p.category ILIKE '%movie%' OR p.category ILIKE '%cinema%'
      OR p.category ILIKE '%animation%' OR p.category ILIKE '%anime%' OR p.category ILIKE '%cartoon%'
      OR p.category ILIKE '%kids%' OR p.category ILIKE '%family%' OR p.category ILIKE '%drama%'
      OR p.category ILIKE '%thriller%' OR p.category ILIKE '%horror%' OR p.category ILIKE '%documentary%'
      OR p.category ILIKE '%sci-fi%' OR p.category ILIKE '%action%' OR p.category ILIKE '%adventure%'
      OR p.category ILIKE '%comedy%' OR p.category ILIKE '%fantasy%' OR p.category ILIKE '%series%'
      OR p.genre ILIKE '%animation%' OR p.genre ILIKE '%kids%' OR p.genre ILIKE '%family%'
      OR p.genre ILIKE '%drama%' OR p.genre ILIKE '%comedy%' OR p.genre ILIKE '%action%'
      OR p.genre ILIKE '%thriller%' OR p.genre ILIKE '%horror%' OR p.genre ILIKE '%fantasy%'
    ) AND NOT ${musicCat}`;
    default: return null;
  }
}

// GET /api/search?q=&categories=cat1,cat2&tags=Movies & TV,Events
router.get('/', authenticate, async (req, res) => {
  const { q, categories: categoriesStr, tags: tagsStr } = req.query;
  const queryText = (q || '').trim();
  const categories = categoriesStr
    ? categoriesStr.split(',').map(c => c.trim()).filter(Boolean)
    : [];
  const tags = tagsStr
    ? tagsStr.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  if (!queryText && categories.length === 0 && tags.length === 0) {
    return res.json({ products: [], boards: [], brands: [], categories: [] });
  }

  try {
    // ── Products ──────────────────────────────────────────────────
    const productConditions = ['up.user_id = $1'];
    const productParams = [req.user.id];
    let pi = 2;

    if (categories.length > 0) {
      productConditions.push(`p.category = ANY($${pi})`);
      productParams.push(categories);
      pi++;
    }

    // Type-based tag conditions — joined with OR so selecting "Music" OR "Events" works
    if (tags.length > 0) {
      const tagClauses = tags.map(t => tagCondition(t)).filter(Boolean);
      if (tagClauses.length > 0) {
        productConditions.push(`(${tagClauses.join(' OR ')})`);
      }
    }
    if (queryText) {
      productConditions.push(
        `(p.search_vector @@ plainto_tsquery('english', $${pi})
          OR p.name ILIKE $${pi + 1}
          OR p.brand ILIKE $${pi + 1})`
      );
      productParams.push(queryText, `%${queryText}%`);
      pi += 2;
    }

    const productResult = await query(
      `SELECT DISTINCT p.id, p.name, p.brand, p.image_url, p.category,
              pr.current_price::float AS lowest_price, pr.currency,
              up.created_at AS saved_at
       FROM products p
       JOIN user_products up ON up.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT current_price, currency
         FROM product_retailers
         WHERE product_id = p.id AND current_price IS NOT NULL
         ORDER BY current_price ASC LIMIT 1
       ) pr ON true
       WHERE ${productConditions.join(' AND ')}
       ORDER BY up.created_at DESC
       LIMIT 20`,
      productParams
    );

    // ── Boards ────────────────────────────────────────────────────
    let boardRows = [];
    if (queryText) {
      // Name match
      const r = await query(
        `SELECT b.id, b.name, b.emoji, b.description,
                COUNT(DISTINCT bi.product_id)::int AS product_count,
                (SELECT p2.image_url FROM products p2
                 JOIN board_items bi2 ON bi2.product_id = p2.id
                 WHERE bi2.board_id = b.id AND p2.image_url IS NOT NULL
                 ORDER BY bi2.added_at DESC LIMIT 1) AS cover_image,
                false AS is_collaborative,
                b.created_at
         FROM boards b
         LEFT JOIN board_items bi ON bi.board_id = b.id
         WHERE b.owner_id = $1 AND b.name ILIKE $2
         GROUP BY b.id
         ORDER BY b.created_at DESC
         LIMIT 5`,
        [req.user.id, `%${queryText}%`]
      );
      boardRows = r.rows;
    } else if (categories.length > 0) {
      // Boards that contain products in the selected categories
      const r = await query(
        `SELECT DISTINCT b.id, b.name, b.emoji, b.description,
                COUNT(DISTINCT bi.product_id)::int AS product_count,
                (SELECT p2.image_url FROM products p2
                 JOIN board_items bi2 ON bi2.product_id = p2.id
                 WHERE bi2.board_id = b.id AND p2.image_url IS NOT NULL
                 ORDER BY bi2.added_at DESC LIMIT 1) AS cover_image,
                false AS is_collaborative,
                b.created_at
         FROM boards b
         JOIN board_items bi ON bi.board_id = b.id
         JOIN products p ON p.id = bi.product_id
         WHERE b.owner_id = $1 AND p.category = ANY($2)
         GROUP BY b.id
         ORDER BY b.created_at DESC
         LIMIT 5`,
        [req.user.id, categories]
      );
      boardRows = r.rows;
    }

    // ── Brands (from matching products) ───────────────────────────
    let brandRows = [];
    {
      const conditions = ['up.user_id = $1', "p.brand IS NOT NULL AND p.brand <> ''"];
      const params = [req.user.id];
      let bi = 2;

      if (categories.length > 0) {
        conditions.push(`p.category = ANY($${bi})`);
        params.push(categories);
        bi++;
      }
      if (queryText) {
        conditions.push(
          `(p.search_vector @@ plainto_tsquery('english', $${bi})
            OR p.name ILIKE $${bi + 1}
            OR p.brand ILIKE $${bi + 1})`
        );
        params.push(queryText, `%${queryText}%`);
      }

      const r = await query(
        `SELECT p.brand AS name, COUNT(*)::int AS product_count
         FROM products p
         JOIN user_products up ON up.product_id = p.id
         WHERE ${conditions.join(' AND ')}
         GROUP BY p.brand
         ORDER BY product_count DESC
         LIMIT 6`,
        params
      );
      brandRows = r.rows;
    }

    // ── Categories (from matching products — only for text search) ─
    let categoryRows = [];
    if (queryText) {
      const r = await query(
        `SELECT p.category AS name, COUNT(*)::int AS product_count
         FROM products p
         JOIN user_products up ON up.product_id = p.id
         WHERE up.user_id = $1
           AND p.category IS NOT NULL AND p.category <> ''
           AND (p.search_vector @@ plainto_tsquery('english', $2)
                OR p.name ILIKE $3
                OR p.brand ILIKE $3)
         GROUP BY p.category
         ORDER BY product_count DESC
         LIMIT 5`,
        [req.user.id, queryText, `%${queryText}%`]
      );
      categoryRows = r.rows;
    }

    res.json({
      products: productResult.rows,
      boards: boardRows,
      brands: brandRows,
      categories: categoryRows,
    });
  } catch (err) {
    console.error('search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
