require('dotenv').config({ override: true });
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { logger } = require('./utils/logger');
const { testConnection } = require('./database/db');

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
  // Run async after responding so the HTTP connection doesn't time out
  const { query } = require('./database/db');
  const { uploadProductImages } = require('./services/storageService');
  const { logger } = require('./utils/logger');
  (async () => {
    logger.info('=== S3 Image Migration Starting ===');
    const result = await query(`SELECT id, name, image_url, images FROM products WHERE image_url IS NOT NULL ORDER BY created_at DESC`);
    const products = result.rows;
    logger.info(`Migrating ${products.length} products`);
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
        logger.info(`[OK] "${p.name}" — uploaded to S3`);
        updated++;
      } catch (err) {
        logger.warn(`[FAIL] "${p.name}" — ${err.message}`);
        errors++;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    logger.info(`=== Migration Complete === updated:${updated} skipped:${skipped} errors:${errors}`);
  })().catch(err => logger.error('Migration error', { error: err.message }));
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
  const { startScheduler } = require('./jobs/priceTracker');
  startScheduler();
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT} [${process.env.NODE_ENV}]`);
  });
}

start();

module.exports = app;
