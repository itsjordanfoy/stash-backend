/**
 * Backfill additional retailers for products that only have their original import URL.
 * Uses search-based discovery so all URLs are real and prices are live-scraped.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: true });

const { query } = require('../database/db');
const { findRetailersForProduct } = require('../services/aiService');
const { scrapeRetailerPrice, isSameProduct } = require('../services/scraperService');

async function backfillProduct(product) {
  console.log(`\n→ ${product.name} (${product.brand || 'unknown brand'}, ${product.category || 'no category'})`);

  const suggestions = await findRetailersForProduct(product);
  console.log(`  Found ${suggestions.length} search result(s): ${suggestions.map(s => s.retailer_name).join(', ') || 'none'}`);

  let added = 0;
  for (const suggestion of suggestions) {
    try {
      const priceData = await scrapeRetailerPrice(suggestion.url);
      if (!priceData?.price) {
        console.log(`  ✗ ${suggestion.retailer_name}: no price scraped — ${suggestion.url}`);
        continue;
      }
      if (!isSameProduct(product.name, product.brand, priceData.pageTitle)) {
        console.log(`  ✗ ${suggestion.retailer_name}: different product ("${priceData.pageTitle?.slice(0, 60)}") — skipped`);
        continue;
      }
      await query(
        `INSERT INTO product_retailers (product_id, retailer_name, product_url, current_price, currency, in_stock)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (product_id, product_url) DO UPDATE
           SET current_price = EXCLUDED.current_price,
               in_stock      = EXCLUDED.in_stock,
               last_checked  = NOW()`,
        [
          product.id,
          suggestion.retailer_name,
          suggestion.url,
          priceData.price,
          priceData.currency || 'GBP',
          priceData.in_stock ?? true,
        ]
      );
      console.log(`  ✓ ${suggestion.retailer_name}: £${priceData.price} — ${suggestion.url}`);
      added++;
    } catch (err) {
      console.log(`  ✗ ${suggestion.retailer_name}: error — ${err.message}`);
    }
  }
  console.log(`  Added ${added} new retailer(s).`);
  return added;
}

async function main() {
  // Remove any previously-backfilled retailers that failed the product-match check
  // (keep the original import source URL — the one created first per product)
  await query(`
    DELETE FROM product_retailers
    WHERE id NOT IN (
      SELECT DISTINCT ON (product_id) id FROM product_retailers ORDER BY product_id, created_at ASC
    )
  `);
  console.log('Cleared previous backfill results. Starting fresh...');

  const { rows: products } = await query(`
    SELECT p.id, p.name, p.brand, p.category
    FROM products p
    ORDER BY p.name
  `);

  console.log(`Found ${products.length} product(s) to backfill.`);

  let totalAdded = 0;
  for (const product of products) {
    totalAdded += await backfillProduct(product);
    // Small pause between products to be polite to retailer servers
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\nBackfill complete. Total new retailers added: ${totalAdded}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
