require('dotenv').config({ override: true });
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { logger } = require('./utils/logger');
const { testConnection, runMigrations } = require('./database/db');

// Prevent unhandled promise rejections (e.g. DB timeouts) from crashing the process
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (server kept alive):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (server kept alive):', err.message);
});

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const productRoutes = require('./routes/products');
const boardRoutes = require('./routes/boards');
const importRoutes = require('./routes/imports');
const priceRoutes = require('./routes/prices');
const subscriptionRoutes = require('./routes/subscriptions');
const notificationRoutes = require('./routes/notifications');
const searchRoutes = require('./routes/search');
const proxyRoutes = require('./routes/proxy');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
    : '*',
  credentials: true,
}));

// Stripe webhook needs raw body — register before express.json()
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// Test fixtures — static HTML pages used by the nightly test suite.
// Mounted BEFORE the rate limiter so fixture fetches during a test run
// aren't throttled. Serves from backend/public/test-fixtures/.
// No caching so fixture edits take effect immediately during development.
app.use(
  '/test-fixtures',
  express.static(path.join(__dirname, '../public/test-fixtures'), {
    maxAge: 0,
    etag: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// One-off S3 image migration — protected by a secret token, disabled in dev
app.post('/admin/migrate-images', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ message: 'Migration started — check Railway logs for progress' });
  const { query } = require('./database/db');
  const { uploadProductImages } = require('./services/storageService');
  (async () => {
    console.log('[MIGRATE] === S3 Image Migration Starting ===');
    console.log(`[MIGRATE] AWS_S3_BUCKET=${process.env.AWS_S3_BUCKET} AWS_REGION=${process.env.AWS_REGION}`);
    const result = await query(`SELECT id, name, image_url, images FROM products WHERE image_url IS NOT NULL ORDER BY created_at DESC`);
    const products = result.rows;
    console.log(`[MIGRATE] Found ${products.length} products to process`);
    let updated = 0, skipped = 0, errors = 0;
    for (const p of products) {
      const imageList = Array.isArray(p.images) ? p.images : [];
      const allUrls = [p.image_url, ...imageList].filter(Boolean);
      if (allUrls.every(u => u.includes('amazonaws.com'))) { skipped++; continue; }
      try {
        const { imageUrl: newImageUrl, images: newImages } = await uploadProductImages(p.image_url, imageList);
        await query(
          `UPDATE products SET image_url = $1, images = $2::jsonb, updated_at = NOW() WHERE id = $3`,
          [newImageUrl || p.image_url, JSON.stringify(newImages.length ? newImages : imageList), p.id]
        );
        console.log(`[MIGRATE] OK: "${p.name}"`);
        updated++;
      } catch (err) {
        console.log(`[MIGRATE] FAIL: "${p.name}" — ${err.message}`);
        errors++;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    console.log(`[MIGRATE] === Complete === updated:${updated} skipped:${skipped} errors:${errors}`);
  })().catch(err => console.log(`[MIGRATE] Fatal: ${err.message}`));
});

// Test-user cleanup — purges accounts matching stash_test_%@test.internal.
// Used by the nightly test suite to clean up crashed prior runs AND its own
// test users when the run completes. Protected by ADMIN_SECRET.
//
// Defense in depth: the email pattern is hard-coded in the SQL string (not
// parameterized), so even with a leaked secret this endpoint structurally
// cannot touch real user accounts.
//
// Deleting a user cascades user_products, boards, board_items, notifications,
// and import_queue rows per the schema. Global products rows are left intact
// (they're deduped by canonical_id and reused across runs).
app.post('/admin/cleanup-test-users', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    logger.warn('cleanup-test-users denied', {
      ip: req.ip,
      ua: req.headers['user-agent'],
    });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const olderThanMinutes = Math.max(0, Number(req.body?.olderThanMinutes ?? 0));
  const dryRun = req.body?.dryRun === true;
  const { query } = require('./database/db');

  try {
    // Pattern is HARD-CODED in SQL, not parameterized — defense in depth.
    const { rows } = await query(
      `SELECT id, email FROM users
         WHERE email LIKE 'stash_test_%@test.internal'
           AND created_at < NOW() - ($1 || ' minutes')::interval`,
      [olderThanMinutes]
    );

    logger.info('cleanup-test-users', {
      olderThanMinutes,
      dryRun,
      count: rows.length,
      ip: req.ip,
      emails: rows.map(r => r.email),
    });

    if (dryRun) {
      return res.json({
        dryRun: true,
        count: rows.length,
        wouldDelete: rows,
      });
    }

    if (rows.length > 0) {
      await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [rows.map(r => r.id)]);
    }

    return res.json({
      dryRun: false,
      deleted: rows.length,
      emails: rows.map(r => r.email),
    });
  } catch (err) {
    logger.error('cleanup-test-users error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Cleanup failed' });
  }
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/boards', boardRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/prices', priceRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/proxy', proxyRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;
  res.status(status).json({ error: message });
});

async function start() {
  await testConnection();
  await runMigrations();
  const { startScheduler } = require('./jobs/priceTracker');
  startScheduler();
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT} [${process.env.NODE_ENV}]`);
  });
}

start();

module.exports = app;
