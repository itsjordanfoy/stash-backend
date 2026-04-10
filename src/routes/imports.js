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

// Resolve the user's country for region-aware retailer selection.
// Priority: explicit X-Country header → Accept-Language header → GB default.
function resolveRequestCountry(req) {
  const explicit = req.headers['x-country'];
  if (explicit && typeof explicit === 'string' && /^[a-z]{2}$/i.test(explicit)) {
    return explicit.toUpperCase();
  }
  // Accept-Language like "en-US,en;q=0.9" → "US"
  const accept = req.headers['accept-language'];
  if (accept) {
    const m = /^[a-z]{2}[-_]([a-z]{2})/i.exec(accept);
    if (m) return m[1].toUpperCase();
  }
  return 'GB';
}

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
    const result = await startImport({
      userId: req.user.id,
      // All URLs go through the full scraping pipeline — no hard social block.
      // Users should be able to save anything they want.
      sourceType: 'link',
      sourceUrl: url,
      country: resolveRequestCountry(req),
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
    // ── Preprocess for the Anthropic Vision API ────────────────────────────
    // The API rejects images larger than 5 MB (after base64) and rejects
    // mismatched mime types. We use sharp to:
    //   1. Auto-rotate based on EXIF orientation
    //   2. Resize so the longest edge ≤ 2000 px (vision quality is unaffected)
    //   3. Re-encode as JPEG quality 85 (small, vision-safe, single mime type)
    // This single conversion solves both the size limit AND the
    // png-vs-jpeg mime mismatch in one pass.
    const sharp = require('sharp');
    let processedBuffer;
    try {
      processedBuffer = await sharp(req.file.buffer)
        .rotate()                                  // honour EXIF orientation
        .resize({
          width: 2000,
          height: 2000,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    } catch (err) {
      logger.warn('sharp preprocessing failed — falling back to raw buffer', {
        error: err.message,
      });
      processedBuffer = req.file.buffer;
    }

    // Upload the ORIGINAL to S3 for the user's records (full quality preserved)
    let screenshotKey = null;
    try {
      screenshotKey = await uploadScreenshot(req.file.buffer, req.file.mimetype);
    } catch (s3Err) {
      logger.warn('S3 upload skipped — screenshot will not be persisted', { error: s3Err.message });
    }

    // Convert the PROCESSED buffer to base64 for AI vision (always JPEG now)
    const base64Image = processedBuffer.toString('base64');

    const result = await startImport({
      userId: req.user.id,
      sourceType: 'screenshot',
      screenshotKey, // may be null — importService handles this gracefully
      rawText: base64Image, // base64 of the processed JPEG
      screenshotMime: 'image/jpeg', // matches the processed buffer
      country: resolveRequestCountry(req),
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
    // confirmImport calls finaliseImport internally, which now fires
    // discoverRetailersInBackground for product-type items — no need to
    // duplicate it here.
    const productId = await confirmImport(req.params.id, req.user.id, productData);
    res.json({ productId, status: 'completed' });
  } catch (err) {
    logger.error('Import confirm error', { error: err.message });
    res.status(500).json({ error: 'Failed to confirm import' });
  }
});

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
