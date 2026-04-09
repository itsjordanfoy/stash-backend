require('dotenv').config();
const { CronJob } = require('cron');
const { query, transaction } = require('../database/db');
const { scrapeRetailerPrice } = require('../services/scraperService');
const { generateAlternatives } = require('../services/aiService');
const { logger } = require('../utils/logger');

const BATCH_SIZE = 200;
const CONCURRENCY = 10;

/**
 * Daily price tracking job.
 * Only tracks products belonging to paid users.
 * Runs in batches to avoid overwhelming scrapers.
 */
async function runPriceTrackingJob() {
  logger.info('Price tracking job started');
  const startTime = Date.now();

  try {
    // Scrape ALL product retailers that are due a check.
    // Tracking status only controls notifications — prices should always be kept current.
    const retailersResult = await query(
      `SELECT pr.id, pr.product_id, pr.product_url, pr.retailer_name,
              pr.current_price, pr.currency
       FROM product_retailers pr
       WHERE (pr.last_checked IS NULL OR pr.last_checked < NOW() - INTERVAL '23 hours')
       ORDER BY pr.last_checked ASC NULLS FIRST
       LIMIT $1`,
      [BATCH_SIZE]
    );

    const retailers = retailersResult.rows;
    logger.info(`Checking prices for ${retailers.length} retailer URLs`);

    let updated = 0;
    let failed = 0;

    // Process in batches for controlled concurrency
    for (let i = 0; i < retailers.length; i += CONCURRENCY) {
      const batch = retailers.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async retailer => {
          try {
            await checkAndUpdatePrice(retailer);
            updated++;
          } catch (err) {
            failed++;
            logger.warn('Price check failed', {
              retailerId: retailer.id,
              url: retailer.product_url,
              error: err.message,
            });
          }
        })
      );
    }

    const duration = Date.now() - startTime;
    logger.info('Price tracking job complete', { updated, failed, durationMs: duration });
  } catch (err) {
    logger.error('Price tracking job error', { error: err.message });
  }
}

async function checkAndUpdatePrice(retailer) {
  let priceData = null;
  let scrapeError = null;

  try {
    priceData = await scrapeRetailerPrice(retailer.product_url);
  } catch (err) {
    scrapeError = err;
  }

  await transaction(async client => {
    if (scrapeError || !priceData || priceData.price === null) {
      // Track consecutive failures — mark discontinued after 5 in a row
      await client.query(
        `UPDATE product_retailers
         SET last_checked = NOW(),
             consecutive_failures = consecutive_failures + 1,
             is_discontinued = (consecutive_failures + 1 >= 5)
         WHERE id = $1`,
        [retailer.id]
      );
      if (scrapeError) throw scrapeError;
      return;
    }

    const newPrice = priceData.price;
    const oldPrice = retailer.current_price;

    // Successful scrape — reset failure counters
    await client.query(
      `UPDATE product_retailers
       SET current_price = $1, currency = $2, in_stock = $3, last_checked = NOW(),
           consecutive_failures = 0, is_discontinued = FALSE
       WHERE id = $4`,
      [newPrice, priceData.currency || retailer.currency, priceData.in_stock, retailer.id]
    );

    // Check if this is the first ever history entry for the product
    const historyCount = await client.query(
      'SELECT COUNT(*) as count FROM price_history WHERE product_id = $1',
      [retailer.product_id]
    );
    const isFirstRecord = parseInt(historyCount.rows[0].count) === 0;

    // Record if price changed, or if this is the first record (seed the baseline)
    if (isFirstRecord || oldPrice === null || Math.abs(newPrice - parseFloat(oldPrice)) > 0.01) {
      await client.query(
        `INSERT INTO price_history (product_id, retailer_id, retailer_name, price, currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [retailer.product_id, retailer.id, retailer.retailer_name, newPrice, priceData.currency || retailer.currency]
      );

      // Check if this is the lowest ever
      const lowestResult = await client.query(
        'SELECT MIN(price) as lowest FROM price_history WHERE product_id = $1',
        [retailer.product_id]
      );
      const lowestEver = lowestResult.rows[0]?.lowest;

      if (lowestEver && newPrice <= parseFloat(lowestEver)) {
        await sendLowestEverNotifications(client, retailer.product_id, newPrice, retailer.retailer_name);
      } else if (oldPrice && newPrice < parseFloat(oldPrice)) {
        await sendPriceDropNotifications(client, retailer.product_id, oldPrice, newPrice, retailer.retailer_name);
      }

      // Check price target crossings
      if (oldPrice !== null) {
        await sendPriceTargetNotifications(client, retailer.product_id, parseFloat(oldPrice), newPrice);
      }

      logger.debug('Price updated', {
        productId: retailer.product_id,
        retailer: retailer.retailer_name,
        oldPrice,
        newPrice,
      });
    }
  });
}

async function sendPriceDropNotifications(client, productId, oldPrice, newPrice, retailerName) {
  const usersResult = await client.query(
    `SELECT u.id, u.push_token, p.name as product_name
     FROM users u
     JOIN user_products up ON up.user_id = u.id
     JOIN products p ON p.id = up.product_id
     WHERE up.product_id = $1
       AND u.subscription_status = 'paid'
       AND up.is_tracking = TRUE
       AND u.push_token IS NOT NULL`,
    [productId]
  );

  for (const user of usersResult.rows) {
    const drop = Math.round(((oldPrice - newPrice) / oldPrice) * 100);
    await client.query(
      `INSERT INTO notifications (user_id, type, product_id, title, body, data)
       VALUES ($1, 'price_drop', $2, $3, $4, $5)`,
      [
        user.id,
        productId,
        `Price dropped ${drop}%`,
        `${user.product_name} is now £${newPrice.toFixed(2)} at ${retailerName}`,
        JSON.stringify({ old_price: oldPrice, new_price: newPrice, retailer: retailerName }),
      ]
    );
    // TODO: send APNs push notification using user.push_token
  }
}

async function sendLowestEverNotifications(client, productId, price, retailerName) {
  const usersResult = await client.query(
    `SELECT u.id, u.push_token, p.name as product_name
     FROM users u
     JOIN user_products up ON up.user_id = u.id
     JOIN products p ON p.id = up.product_id
     WHERE up.product_id = $1
       AND u.subscription_status = 'paid'
       AND up.is_tracking = TRUE
       AND u.push_token IS NOT NULL`,
    [productId]
  );

  for (const user of usersResult.rows) {
    await client.query(
      `INSERT INTO notifications (user_id, type, product_id, title, body, data)
       VALUES ($1, 'lowest_ever', $2, $3, $4, $5)`,
      [
        user.id,
        productId,
        'Lowest price ever!',
        `${user.product_name} has hit its lowest price — £${price.toFixed(2)} at ${retailerName}`,
        JSON.stringify({ price, retailer: retailerName }),
      ]
    );
  }
}

async function sendPriceTargetNotifications(client, productId, oldPrice, newPrice) {
  // Only notify when price crosses BELOW the target for the first time
  if (oldPrice <= newPrice) return; // Price didn't drop

  const usersResult = await client.query(
    `SELECT u.id, u.push_token, p.name as product_name, up.price_target
     FROM users u
     JOIN user_products up ON up.user_id = u.id
     JOIN products p ON p.id = up.product_id
     WHERE up.product_id = $1
       AND up.price_target IS NOT NULL
       AND $2 <= up.price_target
       AND $3 > up.price_target
       AND up.is_tracking = TRUE`,
    [productId, newPrice, oldPrice]
  );

  for (const user of usersResult.rows) {
    await client.query(
      `INSERT INTO notifications (user_id, type, product_id, title, body, data)
       VALUES ($1, 'price_target', $2, $3, $4, $5)`,
      [
        user.id,
        productId,
        'Price target reached!',
        `${user.product_name} dropped to ${newPrice.toFixed(2)} — at or below your target`,
        JSON.stringify({ new_price: newPrice, target: parseFloat(user.price_target) }),
      ]
    );
  }
}

/**
 * Weekly alternatives refresh job.
 * Re-generates AI alternatives for recently saved products.
 */
async function runAlternativesRefreshJob() {
  logger.info('Alternatives refresh job started');

  try {
    const productsResult = await query(
      `SELECT DISTINCT p.id, p.name, p.brand, p.category, p.description
       FROM products p
       JOIN user_products up ON up.product_id = p.id
       WHERE p.updated_at < NOW() - INTERVAL '7 days'
       LIMIT 20`
    );

    for (const product of productsResult.rows) {
      try {
        const alternatives = await generateAlternatives(product);
        // In production: search for real products and store in product_alternatives
        // For now we just log
        logger.debug('Generated alternatives', {
          productId: product.id,
          count: alternatives.length,
        });
      } catch (err) {
        logger.warn('Alternatives refresh failed', { productId: product.id });
      }
    }

    logger.info('Alternatives refresh complete');
  } catch (err) {
    logger.error('Alternatives refresh job error', { error: err.message });
  }
}

function startScheduler() {
  // Daily price tracking — 3 AM UTC
  const priceJob = new CronJob('0 3 * * *', runPriceTrackingJob, null, true, 'UTC');

  // Weekly alternatives refresh — Sunday 4 AM UTC
  const altJob = new CronJob('0 4 * * 0', runAlternativesRefreshJob, null, true, 'UTC');

  logger.info('Scheduler started', {
    nextPriceCheck: priceJob.nextDate().toISO(),
    nextAltRefresh: altJob.nextDate().toISO(),
  });
}

async function checkProductPricesNow(productId) {
  // Only check retailers that haven't been checked in the last 60 minutes
  const retailersResult = await query(
    `SELECT id, product_id, product_url, retailer_name, current_price, currency
     FROM product_retailers
     WHERE product_id = $1
       AND (last_checked IS NULL OR last_checked < NOW() - INTERVAL '60 minutes')`,
    [productId]
  );

  const retailers = retailersResult.rows;
  if (retailers.length === 0) return; // All retailers recently checked — skip

  // Process with same concurrency cap as the daily job
  for (let i = 0; i < retailers.length; i += CONCURRENCY) {
    const batch = retailers.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(retailer => checkAndUpdatePrice(retailer)));
  }
}

module.exports = { runPriceTrackingJob, runAlternativesRefreshJob, startScheduler, checkProductPricesNow };
