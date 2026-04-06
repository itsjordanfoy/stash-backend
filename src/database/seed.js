require('dotenv').config();
const { pool } = require('./db');

const products = [
  {
    name: 'BeoGrace',
    brand: 'Bang & Olufsen',
    description: 'Premium wireless earphones crafted from natural aluminium with adaptive active noise cancellation and signature B&O sound.',
    category: 'Audio',
    image_url: 'https://images.ctfassets.net/8cd2csgvqd3m/5OT4Ao8wtV233U9PEuRIR0/06ad4ca0598d6f9893061745153d1e5f/Packshot-Beo-Natural-Aluminium-Front-0005-s1200x1200px_2.png',
    source_url: 'https://www.bang-olufsen.com/en/gb/earphones/beograce?variant=beograce-natural-aluminium',
    retailers: [
      { name: 'Bang & Olufsen', url: 'https://www.bang-olufsen.com/en/gb/earphones/beograce?variant=beograce-natural-aluminium', price: 349.00, currency: 'GBP' },
    ],
  },
  {
    name: 'Long Sleeve Rally Tee',
    brand: 'Aimé Leon Dore',
    description: 'Classic long-sleeve jersey tee with ribbed cuffs and hem. Made from heavyweight cotton with the signature ALD Rally embroidery.',
    category: 'Clothing',
    image_url: 'https://eu.aimeleondore.com/cdn/shop/files/AimeLeonDore69af23ac7ada6669af23ac7aed2.9105743869af23ac7aed2_grande.jpg?v=1773086880',
    source_url: 'https://eu.aimeleondore.com/products/long-sleeve-rally-tee',
    retailers: [
      { name: 'Aimé Leon Dore', url: 'https://eu.aimeleondore.com/products/long-sleeve-rally-tee', price: 110.00, currency: 'GBP' },
    ],
  },
  {
    name: 'Horizon 20 Pro',
    brand: 'XGIMI',
    description: '4K UHD smart projector with Dolby Vision, Harman Kardon audio, and intelligent screen alignment. 2300 ANSI lumens.',
    category: 'Projectors',
    image_url: 'https://uk.xgimi.com/cdn/shop/files/HORIZON_20_Pro_c1763206-2cb7-4280-a634-a22e9bbf5379_1200x1200.webp?v=1773111679',
    source_url: 'https://uk.xgimi.com/products/horizon-20-pro',
    retailers: [
      { name: 'XGIMI UK', url: 'https://uk.xgimi.com/products/horizon-20-pro', price: 1299.00, currency: 'GBP' },
    ],
  },
  {
    name: 'MacBook Neo',
    brand: 'Apple',
    description: 'Apple\'s thinnest Mac ever. Powered by M5, with an all-day battery and a stunning Liquid Retina display.',
    category: 'Laptops',
    image_url: 'https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/mba13-midnight-select-202402?wid=904&hei=840&fmt=jpeg&qlt=90&.v=1708367688034',
    source_url: 'https://www.apple.com/uk/macbook-neo/',
    retailers: [
      { name: 'Apple', url: 'https://www.apple.com/uk/macbook-neo/', price: 1299.00, currency: 'GBP' },
    ],
  },
];

async function seed() {
  const client = await pool.connect();
  try {
    // Find first user
    const userResult = await client.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    if (userResult.rows.length === 0) {
      console.error('No users found — sign up in the app first, then re-run the seed.');
      process.exit(1);
    }
    const userId = userResult.rows[0].id;
    console.log(`Seeding products for user ${userId}`);

    for (const p of products) {
      // Insert product
      const prodResult = await client.query(
        `INSERT INTO products (name, brand, description, category, image_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [p.name, p.brand, p.description, p.category, p.image_url]
      );

      let productId;
      if (prodResult.rows.length > 0) {
        productId = prodResult.rows[0].id;
      } else {
        // Already exists — find it
        const existing = await client.query(
          'SELECT id FROM products WHERE name = $1 AND brand = $2',
          [p.name, p.brand]
        );
        if (existing.rows.length === 0) continue;
        productId = existing.rows[0].id;
      }

      // Insert retailers
      for (const r of p.retailers) {
        await client.query(
          `INSERT INTO product_retailers (product_id, retailer_name, product_url, current_price, currency)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (product_id, product_url) DO UPDATE SET current_price = $4`,
          [productId, r.name, r.url, r.price, r.currency]
        );

        // Seed a price history point
        await client.query(
          `INSERT INTO price_history (product_id, retailer_name, price, currency, timestamp)
           VALUES ($1, $2, $3, $4, NOW())`,
          [productId, r.name, r.price, r.currency]
        );
      }

      // Link to user
      await client.query(
        `INSERT INTO user_products (user_id, product_id, source_url, source_type, is_tracking)
         VALUES ($1, $2, $3, 'link', true)
         ON CONFLICT (user_id, product_id) DO NOTHING`,
        [userId, productId, p.source_url]
      );

      console.log(`  ✓ ${p.brand} ${p.name}`);
    }

    console.log('Seed complete.');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
