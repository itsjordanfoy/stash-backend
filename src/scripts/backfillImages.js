/**
 * backfillImages.js
 *
 * One-off script to re-scrape retailer URLs for all existing products that
 * have an empty images array, and populate products.images (+ image_url if null).
 *
 * Usage:
 *   cd backend && node src/scripts/backfillImages.js
 */

require('dotenv').config();
const { pool, query } = require('../database/db');
const { fetchPage, parseProductPage } = require('../services/scraperService');
const { logger } = require('../utils/logger');

const CONCURRENCY = 3;   // parallel product workers
const DELAY_MS    = 800; // polite delay between scrape requests

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Scrape a URL and return the images array (may be empty). */
async function scrapeImages(url) {
  try {
    const result = await fetchPage(url);
    if (!result || !result.html) return [];
    const parsed = parseProductPage(result.html, url);
    return (parsed && Array.isArray(parsed.images)) ? parsed.images : [];
  } catch (err) {
    logger.warn('scrapeImages failed', { url, error: err.message });
    return [];
  }
}

/** Process a single product: find its retailer URLs, scrape, update DB. */
async function processProduct(product) {
  const { id, name, image_url } = product;

  // Gather retailer URLs for this product
  const retailerRes = await query(
    'SELECT product_url FROM product_retailers WHERE product_id = $1 ORDER BY id ASC',
    [id]
  );
  const urls = retailerRes.rows.map(r => r.product_url).filter(Boolean);

  if (urls.length === 0) {
    logger.info(`[${id}] "${name}" — no retailer URLs, skipping`);
    return { id, status: 'skipped', images: [] };
  }

  const allImages = [];
  const seen = new Set();

  for (const url of urls) {
    if (allImages.length >= 8) break;
    logger.info(`[${id}] Scraping ${url}`);
    const imgs = await scrapeImages(url);
    for (const img of imgs) {
      if (!seen.has(img)) {
        seen.add(img);
        allImages.push(img);
      }
      if (allImages.length >= 8) break;
    }
    await sleep(DELAY_MS);
  }

  if (allImages.length === 0) {
    logger.info(`[${id}] "${name}" — no images found on any retailer page`);
    return { id, status: 'no_images', images: [] };
  }

  // Determine the best image_url (use first scraped image if current is null)
  const newImageUrl = image_url || allImages[0];

  await query(
    `UPDATE products
        SET images     = $1::jsonb,
            image_url  = COALESCE(image_url, $2),
            updated_at = NOW()
      WHERE id = $3`,
    [JSON.stringify(allImages), newImageUrl, id]
  );

  logger.info(`[${id}] "${name}" — saved ${allImages.length} image(s)`);
  return { id, status: 'updated', images: allImages };
}

/** Run tasks with a simple concurrency pool. */
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const task = tasks[index++];
      try {
        results.push(await task());
      } catch (err) {
        logger.error('Task error', { error: err.message });
        results.push({ status: 'error', error: err.message });
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  logger.info('=== Image Backfill Script Starting ===');

  // Fetch all products that need backfilling
  const res = await query(`
    SELECT id, name, image_url
      FROM products
     WHERE images IS NULL
        OR images = '[]'::jsonb
        OR jsonb_array_length(images) = 0
     ORDER BY created_at DESC
  `);

  const products = res.rows;
  logger.info(`Found ${products.length} product(s) to backfill`);

  if (products.length === 0) {
    logger.info('Nothing to do — all products already have images.');
    await pool.end();
    return;
  }

  const tasks = products.map(p => () => processProduct(p));
  const results = await runWithConcurrency(tasks, CONCURRENCY);

  // Summary
  const updated  = results.filter(r => r.status === 'updated').length;
  const skipped  = results.filter(r => r.status === 'skipped').length;
  const noImages = results.filter(r => r.status === 'no_images').length;
  const errors   = results.filter(r => r.status === 'error').length;

  logger.info('=== Backfill Complete ===');
  logger.info(`  Updated : ${updated}`);
  logger.info(`  Skipped : ${skipped} (no retailer URLs)`);
  logger.info(`  No imgs : ${noImages} (scrape returned nothing)`);
  logger.info(`  Errors  : ${errors}`);

  await pool.end();
}

main().catch(err => {
  logger.error('Fatal error in backfill script', err);
  process.exit(1);
});
