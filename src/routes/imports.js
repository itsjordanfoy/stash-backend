const express = require('express');
const multer = require('multer');
const { authenticate, loadUserData } = require('../middleware/auth');
const { startImport, confirmImport, getImportStatus } = require('../services/importService');
const { uploadScreenshot } = require('../services/storageService');
const { detectSourceType } = require('../services/scraperService');
const { logger } = require('../utils/logger');

const router = express.Router();

// In-memory multer (screenshots go straight to S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// POST /api/imports/link
router.post('/link', authenticate, loadUserData, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    new URL(url); // validate
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const sourceType = detectSourceType(url);
    const result = await startImport({
      userId: req.user.id,
      sourceType: ['instagram', 'tiktok', 'pinterest'].includes(sourceType) ? 'social' : 'link',
      sourceUrl: url,
    });

    res.status(202).json(result);
  } catch (err) {
    logger.error('Link import error', { error: err.message });
    res.status(500).json({ error: 'Import failed' });
  }
});

// POST /api/imports/screenshot
router.post('/screenshot', authenticate, loadUserData, upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Screenshot file required' });

  try {
    // Upload to S3
    const screenshotKey = await uploadScreenshot(req.file.buffer, req.file.mimetype);

    // Convert to base64 for AI analysis
    const base64Image = req.file.buffer.toString('base64');

    const result = await startImport({
      userId: req.user.id,
      sourceType: 'screenshot',
      screenshotKey,
      rawText: base64Image, // passed to AI vision
    });

    res.status(202).json(result);
  } catch (err) {
    logger.error('Screenshot import error', { error: err.message });
    res.status(500).json({ error: 'Import failed' });
  }
});

// GET /api/imports/:id — poll import status
router.get('/:id', authenticate, async (req, res) => {
  try {
    const status = await getImportStatus(req.params.id, req.user.id);
    if (!status) return res.status(404).json({ error: 'Import not found' });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get import status' });
  }
});

// POST /api/imports/:id/confirm — user confirms a product from suggestions
router.post('/:id/confirm', authenticate, async (req, res) => {
  const { productData } = req.body;
  if (!productData) return res.status(400).json({ error: 'productData required' });

  try {
    const productId = await confirmImport(req.params.id, req.user.id, productData);
    res.json({ productId, status: 'completed' });

    // Auto-discover additional retailers in the background — don't block the response
    discoverRetailersInBackground(productId, productData).catch(() => {});
  } catch (err) {
    logger.error('Import confirm error', { error: err.message });
    res.status(500).json({ error: 'Failed to confirm import' });
  }
});

async function discoverRetailersInBackground(productId, productData) {
  const { findRetailersForProduct } = require('../services/aiService');
  const { scrapeRetailerPrice, isSameProduct } = require('../services/scraperService');
  const { query } = require('../database/db');

  const product = {
    id: productId,
    name: productData.name,
    brand: productData.brand,
    category: productData.category,
  };

  const suggestions = await findRetailersForProduct(product);

  await Promise.allSettled(
    suggestions.map(async suggestion => {
      if (!suggestion.url || !suggestion.retailer_name) return;
      try {
        const priceData = await scrapeRetailerPrice(suggestion.url);
        if (!priceData?.price) return;

        // Reject if the page is for a different product (e.g. search returned a similar but wrong item)
        if (!isSameProduct(product.name, product.brand, priceData.pageTitle)) {
          logger.debug('Retailer search result rejected — different product', {
            product: product.name,
            retailer: suggestion.retailer_name,
            pageTitle: priceData.pageTitle,
          });
          return;
        }

        await query(
          `INSERT INTO product_retailers (product_id, retailer_name, product_url, current_price, currency, in_stock)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (product_id, product_url) DO UPDATE
             SET current_price = EXCLUDED.current_price,
                 in_stock = EXCLUDED.in_stock,
                 last_checked = NOW()`,
          [productId, suggestion.retailer_name, suggestion.url, priceData.price, priceData.currency || 'GBP', priceData.in_stock ?? true]
        );
      } catch {}
    })
  );
}

// GET /api/imports — user's recent imports
router.get('/', authenticate, async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  const { query } = require('../database/db');
  try {
    const result = await query(
      `SELECT iq.id, iq.source_type, iq.status, iq.error, iq.created_at,
              p.id as product_id, p.name as product_name, p.image_url
       FROM import_queue iq
       LEFT JOIN products p ON p.id = iq.product_id
       WHERE iq.user_id = $1
       ORDER BY iq.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json({ imports: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load imports' });
  }
});

module.exports = router;
