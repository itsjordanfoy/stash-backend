const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/db');
const { authenticate, loadUserData, requirePaid } = require('../middleware/auth');
const { randomBytes } = require('crypto');
const { logger } = require('../utils/logger');

const router = express.Router();

/** Returns true if user owns or is a collaborator on a board */
async function hasAccess(boardId, userId) {
  const r = await query(
    `SELECT 1 FROM boards WHERE id = $1 AND owner_id = $2
     UNION
     SELECT 1 FROM board_collaborators WHERE board_id = $1 AND user_id = $2
     LIMIT 1`,
    [boardId, userId]
  );
  return r.rows.length > 0;
}

// GET /api/boards  — user's own + collaborative boards
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT b.*,
              CASE WHEN b.owner_id = $1 THEN 'owner' ELSE 'editor' END AS role,
              COUNT(DISTINCT bi.product_id)::int AS product_count,
              (SELECT p.image_url FROM products p
               JOIN board_items bi2 ON bi2.product_id = p.id
               WHERE bi2.board_id = b.id AND p.image_url IS NOT NULL
               ORDER BY bi2.added_at DESC LIMIT 1) AS cover_image,
              ARRAY(
                SELECT COALESCE(p.image_url, p.images->>0) FROM products p
                JOIN board_items bi3 ON bi3.product_id = p.id
                WHERE bi3.board_id = b.id
                  AND (p.image_url IS NOT NULL OR jsonb_array_length(COALESCE(p.images, '[]'::jsonb)) > 0)
                ORDER BY bi3.added_at DESC LIMIT 4
              ) AS preview_images
       FROM boards b
       LEFT JOIN board_items bi ON bi.board_id = b.id
       LEFT JOIN board_collaborators bc ON bc.board_id = b.id AND bc.user_id = $1
       WHERE b.owner_id = $1 OR bc.user_id IS NOT NULL
       GROUP BY b.id
       ORDER BY b.sort_order ASC, b.created_at DESC`,
      [req.user.id]
    );
    res.json({ boards: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load boards' });
  }
});

// POST /api/boards
router.post(
  '/',
  authenticate,
  [
    body('name').trim().isLength({ min: 1, max: 255 }),
    body('emoji').optional().trim(),
    body('description').optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, emoji, description } = req.body;
    try {
      const result = await query(
        `INSERT INTO boards (owner_id, name, emoji, description)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.user.id, name, emoji || null, description || null]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create board' });
    }
  }
);

// GET /api/boards/:id
router.get('/:id', authenticate, async (req, res) => {
  const { sort = 'added', order = 'desc' } = req.query;

  const sortMap = {
    added: 'bi.added_at',
    price: 'lowest_price',
    updated: 'p.updated_at',
    name: 'p.name',
  };
  const sortCol = sortMap[sort] || 'bi.added_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  try {
    const boardResult = await query(
      `SELECT b.*,
              CASE WHEN b.owner_id = $2 THEN 'owner' ELSE 'editor' END AS role
       FROM boards b
       LEFT JOIN board_collaborators bc ON bc.board_id = b.id AND bc.user_id = $2
       WHERE b.id = $1 AND (b.owner_id = $2 OR bc.user_id IS NOT NULL OR b.is_public = true)`,
      [req.params.id, req.user.id]
    );

    if (boardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Board not found' });
    }

    const productsResult = await query(
      `SELECT p.id, p.name, p.brand, p.image_url, p.category,
              bi.added_at, bi.position,
              cheapest.lowest_price,
              cheapest.currency,
              p.updated_at
       FROM board_items bi
       JOIN products p ON p.id = bi.product_id
       LEFT JOIN LATERAL (
         SELECT current_price::float AS lowest_price, currency
         FROM product_retailers
         WHERE product_id = p.id AND current_price IS NOT NULL
         ORDER BY current_price ASC
         LIMIT 1
       ) AS cheapest ON true
       WHERE bi.board_id = $1
       ORDER BY ${sortCol} ${sortDir} NULLS LAST`,
      [req.params.id]
    );

    res.json({ board: boardResult.rows[0], products: productsResult.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// PATCH /api/boards/:id
router.patch('/:id', authenticate, async (req, res) => {
  const { name, emoji, description, sort_order } = req.body;
  try {
    const result = await query(
      `UPDATE boards
       SET name = COALESCE($1, name),
           emoji = COALESCE($2, emoji),
           description = COALESCE($3, description),
           sort_order = COALESCE($4, sort_order)
       WHERE id = $5 AND owner_id = $6
       RETURNING *`,
      [name, emoji, description, sort_order, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Board not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update board' });
  }
});

// DELETE /api/boards/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await query('DELETE FROM boards WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete board' });
  }
});

// POST /api/boards/:id/products  — add product to board (owner or collaborator)
router.post('/:id/products', authenticate, async (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId required' });

  try {
    if (!await hasAccess(req.params.id, req.user.id)) {
      return res.status(403).json({ error: 'Board not found or access denied' });
    }

    const owns = await query(
      'SELECT id FROM user_products WHERE user_id = $1 AND product_id = $2',
      [req.user.id, productId]
    );
    if (owns.rows.length === 0) {
      return res.status(403).json({ error: 'Product not in your library' });
    }

    await query(
      `INSERT INTO board_items (board_id, product_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (board_id, product_id) DO NOTHING`,
      [req.params.id, productId, req.user.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add product to board' });
  }
});

// DELETE /api/boards/:id/products/:productId  — owner or collaborator can remove
router.delete('/:id/products/:productId', authenticate, async (req, res) => {
  try {
    if (!await hasAccess(req.params.id, req.user.id)) {
      return res.status(403).json({ error: 'Board not found or access denied' });
    }
    await query(
      'DELETE FROM board_items WHERE board_id = $1 AND product_id = $2',
      [req.params.id, req.params.productId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove product from board' });
  }
});

// POST /api/boards/:id/invite  — generate a shareable invite code
router.post('/:id/invite', authenticate, async (req, res) => {
  try {
    // Only owner can invite
    const boardResult = await query(
      'SELECT id, name FROM boards WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (boardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Board not found' });
    }

    // Reuse existing valid invite if one exists
    const existing = await query(
      `SELECT code FROM board_invites
       WHERE board_id = $1 AND created_by = $2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, req.user.id]
    );

    const code = existing.rows.length > 0
      ? existing.rows[0].code
      : (() => {
          const raw = randomBytes(4).toString('hex').toUpperCase(); // 8 chars
          return raw;
        })();

    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO board_invites (board_id, code, created_by)
         VALUES ($1, $2, $3)`,
        [req.params.id, code, req.user.id]
      );
    }

    res.json({
      code,
      boardName: boardResult.rows[0].name,
      inviteUrl: `producttracker://join?code=${code}`,
    });
  } catch (err) {
    logger.error('Create invite error', { error: err.message });
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// POST /api/boards/join/:code  — join a board via invite code
router.post('/join/:code', authenticate, async (req, res) => {
  try {
    const inviteResult = await query(
      `SELECT bi.board_id, b.name, b.emoji
       FROM board_invites bi
       JOIN boards b ON b.id = bi.board_id
       WHERE bi.code = $1 AND bi.expires_at > NOW()`,
      [req.params.code]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found or expired' });
    }

    const { board_id, name, emoji } = inviteResult.rows[0];

    // Don't add owner as collaborator
    const isOwner = await query(
      'SELECT 1 FROM boards WHERE id = $1 AND owner_id = $2',
      [board_id, req.user.id]
    );
    if (isOwner.rows.length > 0) {
      return res.json({ boardId: board_id, boardName: name, alreadyMember: true });
    }

    await query(
      `INSERT INTO board_collaborators (board_id, user_id, role, accepted_at)
       VALUES ($1, $2, 'editor', NOW())
       ON CONFLICT (board_id, user_id) DO UPDATE SET accepted_at = NOW()`,
      [board_id, req.user.id]
    );

    // Mark the board as collaborative
    await query(
      `UPDATE boards SET is_collaborative = true WHERE id = $1`,
      [board_id]
    );

    res.json({ boardId: board_id, boardName: name, emoji, alreadyMember: false });
  } catch (err) {
    logger.error('Join board error', { error: err.message });
    res.status(500).json({ error: 'Failed to join board' });
  }
});

// DELETE /api/boards/:id/leave  — collaborator leaves a board
router.delete('/:id/leave', authenticate, async (req, res) => {
  try {
    // Only collaborators can leave; owners must delete
    const isOwner = await query(
      'SELECT 1 FROM boards WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (isOwner.rows.length > 0) {
      return res.status(400).json({ error: 'Owners cannot leave — delete the board instead' });
    }

    await query(
      'DELETE FROM board_collaborators WHERE board_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to leave board' });
  }
});

// PATCH /api/boards/:id/items/reorder — drag-to-reorder board products
router.patch('/:id/items/reorder', authenticate, async (req, res) => {
  const { orderedProductIds } = req.body;
  if (!Array.isArray(orderedProductIds)) {
    return res.status(400).json({ error: 'orderedProductIds must be an array' });
  }

  try {
    const boardResult = await query(
      'SELECT id FROM boards WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (boardResult.rows.length === 0) return res.status(404).json({ error: 'Board not found' });

    await transaction(async client => {
      for (let i = 0; i < orderedProductIds.length; i++) {
        await client.query(
          'UPDATE board_items SET position = $1 WHERE board_id = $2 AND product_id = $3',
          [i, req.params.id, orderedProductIds[i]]
        );
      }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reorder board items' });
  }
});

module.exports = router;
