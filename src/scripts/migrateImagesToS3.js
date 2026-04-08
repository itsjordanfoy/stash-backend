/**
 * migrateImagesToS3.js
 *
 * One-off script: downloads every existing product image from the original
 * retailer CDN and re-uploads it to S3. Updates image_url + images in the DB.
 *
 * Safe to re-run — already-migrated products (URLs starting with amazonaws.com)
 * are skipped.
 *
 * Usage (run on Railway via: node src/scripts/migrateImagesToS3.js):
 */

require('dotenv').config();
const { pool, query } = require('../database/db');
const { uploadProductImages } = require('../services/storageService');
const { logger } = require('../utils/logger');

const CONCURRENCY = 4;
const BATCH_SIZE  = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function migrateProduct(product) {
  const { id, name, image_url, images } = product;
  const imageList = Array.isArray(images) ? images : [];

  // Skip if already on S3
  const allUrls = [image_url, ...imageList].filter(Boolean);
  if (allUrls.every(u => u.includes('amazonaws.com'))) {
    return { id, status: 'skipped' };
  }

  try {
    const { imageUrl: newImageUrl, images: newImages } = await uploadProductImages(
      image_url,
      imageList
    );

    await query(
      `UPDATE products
          SET image_url  = $1,
              images     = $2::jsonb,
              updated_at = NOW()
        WHERE id = $3`,
      [newImageUrl || image_url, JSON.stringify(newImages.length ? newImages : imageList), id]
    );

    const uploaded = [newImageUrl, ...newImages].filter(u => u && u.includes('amazonaws.com')).length;
    logger.info(`[OK] "${name}" — ${uploaded}/${allUrls.length} image(s) → S3`);
    return { id, status: 'updated', uploaded };
  } catch (err) {
    logger.warn(`[FAIL] "${name}" — ${err.message}`);
    return { id, status: 'error', error: err.message };
  }
}

async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const task = tasks[index++];
      results.push(await task());
      await sleep(200);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function main() {
  logger.info('=== S3 Image Migration Starting ===');
  logger.info(`Bucket: ${process.env.AWS_S3_BUCKET}, Region: ${process.env.AWS_REGION}`);

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_S3_BUCKET) {
    logger.error('AWS credentials not configured — set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET');
    process.exit(1);
  }

  const res = await query(`
    SELECT id, name, image_url, images
      FROM products
     WHERE image_url IS NOT NULL
     ORDER BY created_at DESC
  `);

  const products = res.rows;
  logger.info(`Found ${products.length} product(s) to process`);

  const tasks = products.map(p => () => migrateProduct(p));
  const results = await runWithConcurrency(tasks, CONCURRENCY);

  const updated = results.filter(r => r.status === 'updated').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors  = results.filter(r => r.status === 'error').length;

  logger.info('=== Migration Complete ===');
  logger.info(`  Updated : ${updated}`);
  logger.info(`  Skipped : ${skipped} (already on S3)`);
  logger.info(`  Errors  : ${errors}`);

  await pool.end();
}

main().catch(err => {
  logger.error('Fatal error', err);
  process.exit(1);
});
