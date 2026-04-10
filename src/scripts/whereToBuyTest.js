#!/usr/bin/env node
/**
 * ┌──────────────────────────────────────────────────────────┐
 * │  Stash — "Where to Buy" Stress Test                      │
 * │                                                          │
 * │  Imports a varied set of product URLs, waits for the     │
 * │  background retailer discovery to populate, then GETs    │
 * │  each stored retailer URL and checks:                    │
 * │    ✓ HTTP status is 2xx/3xx (URL is alive)               │
 * │    ✓ Page title or HTML body mentions the product name   │
 * │      (so we know it's not a "0 results" search page)     │
 * │                                                          │
 * │  Usage:                                                  │
 * │    TEST_BASE_URL=https://stash-backend-production-...    │
 * │    node backend/src/scripts/whereToBuyTest.js            │
 * └──────────────────────────────────────────────────────────┘
 */

require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env'),
  override: true,
});

const crypto = require('crypto');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const POLL_TIMEOUT_MS = 120_000;
const RETAILER_WAIT_MS = 25_000; // give the background discovery time to run
const CHECK_TIMEOUT_MS = 10_000;

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
const c = process.stdout.isTTY ? C : Object.fromEntries(Object.keys(C).map(k => [k, '']));
function log(msg) { process.stdout.write(msg + '\n'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Test corpus — varied real-world products covering all retailer categories ─
const TEST_PRODUCTS = [
  // ── Books (4) ───────────────────────────────────────────────────────────
  { category: 'Book — fiction',  url: 'https://www.amazon.co.uk/Lonesome-Dove-Larry-McMurtry/dp/0330327070' },
  { category: 'Book — non-fic',  url: 'https://www.amazon.co.uk/Sapiens-Humankind-Yuval-Noah-Harari/dp/0099590085' },
  { category: 'Book — cookbook', url: 'https://www.amazon.co.uk/Ottolenghi-SIMPLE-Yotam/dp/1785031163' },
  { category: 'Book — children', url: 'https://www.amazon.co.uk/Gruffalo-Julia-Donaldson/dp/0333710932' },

  // ── Electronics (5) ─────────────────────────────────────────────────────
  { category: 'iPhone',          url: 'https://www.apple.com/uk/shop/buy-iphone/iphone-16-pro' },
  { category: 'Camera',          url: 'https://www.amazon.co.uk/dp/B0BR68YP3K' },
  { category: 'Headphones',      url: 'https://www.amazon.co.uk/dp/B0863TXGM3' },
  { category: 'Laptop',          url: 'https://www.apple.com/uk/shop/buy-mac/macbook-pro' },
  { category: 'TV',              url: 'https://www.amazon.co.uk/dp/B0BNGH9V14' },

  // ── Home & Kitchen (4) ──────────────────────────────────────────────────
  { category: 'IKEA furniture',  url: 'https://www.ikea.com/gb/en/p/kallax-shelving-unit-white-20275806/' },
  { category: 'Cookware',        url: 'https://www.amazon.co.uk/dp/B0029JQEIC' },
  { category: 'Coffee machine',  url: 'https://www.amazon.co.uk/dp/B07XPNRKQX' },
  { category: 'Bedding',         url: 'https://www.amazon.co.uk/dp/B07K34QMLV' },

  // ── Beauty (3) ──────────────────────────────────────────────────────────
  { category: 'Skincare',        url: 'https://www.cultbeauty.co.uk/glossier-balm-dotcom' },
  { category: 'Perfume',         url: 'https://www.amazon.co.uk/dp/B07GVF2MZP' },
  { category: 'Haircare',        url: 'https://www.amazon.co.uk/dp/B084VT5JPS' },

  // ── Fashion (4) ─────────────────────────────────────────────────────────
  { category: 'Trainers',        url: 'https://www.nike.com/gb/t/air-force-1-07-shoe-WrLlWX' },
  { category: 'Hoodie',          url: 'https://www.amazon.co.uk/dp/B07Q1QKT7Y' },
  { category: 'Watch',           url: 'https://www.amazon.co.uk/dp/B09KGM7BSF' },
  { category: 'Sunglasses',      url: 'https://www.amazon.co.uk/dp/B07Y7Y2YJ7' },

  // ── Sport (2) ───────────────────────────────────────────────────────────
  { category: 'Yoga mat',        url: 'https://www.amazon.co.uk/dp/B07GFQNZ5X' },
  { category: 'Football',        url: 'https://www.amazon.co.uk/dp/B0B8BS4VZ8' },

  // ── Music & vinyl (2) ───────────────────────────────────────────────────
  { category: 'Vinyl record',    url: 'https://www.discogs.com/release/2255988-Pink-Floyd-The-Dark-Side-Of-The-Moon' },
  { category: 'Album',           url: 'https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv' },

  // ── Gaming (2) ──────────────────────────────────────────────────────────
  { category: 'Video game',      url: 'https://store.steampowered.com/app/1245620/ELDEN_RING/' },
  { category: 'Console',         url: 'https://www.amazon.co.uk/dp/B0BCNKKZ91' },
];

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function jsonReq(method, urlPath, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function pollImport(importId, token) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(2500);
    try {
      const { data } = await jsonReq('GET', `/api/imports/${importId}`, { token });
      if (data.status === 'completed')             return { status: 'completed', product: data.product };
      if (data.status === 'failed')                return { status: 'failed',    error: data.error };
      if (data.status === 'awaiting_confirmation') return { status: 'awaiting_confirmation' };
    } catch { /* transient */ }
  }
  return { status: 'timeout' };
}

// ── Per-retailer URL liveness + relevance check ──────────────────────────────
async function checkRetailerUrl(url, productName) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    clearTimeout(timer);

    if (res.status >= 400) {
      return { status: res.status, alive: false, hasProductMatch: false };
    }

    // Pull a chunk of the body and look for the product name
    const text = await res.text();
    const lower = text.toLowerCase();
    const productLower = productName.toLowerCase();
    // Strip punctuation from the product name and require at least one significant word match
    const productWords = productLower
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4);
    const matchCount = productWords.filter(w => lower.includes(w)).length;
    const hasProductMatch = matchCount >= Math.min(2, productWords.length);

    return { status: res.status, alive: true, hasProductMatch, matchCount, totalWords: productWords.length };
  } catch (err) {
    return { status: 0, alive: false, hasProductMatch: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`\n${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`${c.bold}${c.cyan}  Stash — Where to Buy Stress Test${c.reset}`);
  log(`${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`${c.dim}  Base URL:    ${BASE_URL}${c.reset}`);
  log(`${c.dim}  Products:    ${TEST_PRODUCTS.length}${c.reset}`);
  log(`${c.dim}  Started:     ${new Date().toISOString()}${c.reset}\n`);

  // Register a fresh test user
  const runId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const user = {
    email: `stash_test_${runId}_wtb@test.internal`,
    password: 'TestPass!9x',
    token: null,
  };
  const reg = await jsonReq('POST', '/api/auth/register', {
    body: { email: user.email, password: user.password },
  });
  if (reg.status !== 201 || !reg.data.token) {
    log(`${c.red}✗ Failed to register test user: ${JSON.stringify(reg.data).slice(0, 200)}${c.reset}`);
    process.exit(1);
  }
  user.token = reg.data.token;
  log(`${c.green}✓${c.reset} Registered ${c.dim}${user.email}${c.reset}\n`);

  const productResults = [];

  // ── Phase 1: Import every product ───────────────────────────────────────
  for (let i = 0; i < TEST_PRODUCTS.length; i++) {
    const entry = TEST_PRODUCTS[i];
    process.stdout.write(`${c.dim}${(i + 1).toString().padStart(2)}/${TEST_PRODUCTS.length}  Importing ${entry.category.padEnd(12)} ${entry.url.slice(0, 60)}…${c.reset}\n`);
    const post = await jsonReq('POST', '/api/imports/link', {
      token: user.token, body: { url: entry.url },
    });
    if (post.status !== 202 || !post.data.importId) {
      log(`     ${c.red}✗ POST failed${c.reset}\n`);
      productResults.push({ ...entry, ok: false, reason: 'POST failed' });
      continue;
    }
    const result = await pollImport(post.data.importId, user.token);
    if (result.status !== 'completed' || !result.product?.id) {
      log(`     ${c.red}✗ ${result.status}${c.reset}\n`);
      productResults.push({ ...entry, ok: false, reason: result.status });
      continue;
    }
    log(`     ${c.green}✓${c.reset} ${c.dim}${result.product.name?.slice(0, 50) || ''}${c.reset}`);
    productResults.push({
      ...entry,
      ok: true,
      productId: result.product.id,
      productName: result.product.name,
    });
  }

  // ── Phase 2: Wait for background retailer discovery ─────────────────────
  log(`\n${c.dim}Waiting ${RETAILER_WAIT_MS / 1000}s for background retailer discovery to populate…${c.reset}`);
  await sleep(RETAILER_WAIT_MS);

  // ── Phase 3: For each product, fetch retailers and verify each URL ──────
  log(`\n${c.bold}${c.cyan}Verifying retailer URLs${c.reset}\n`);
  let totalRetailers = 0;
  let totalAlive = 0;
  let totalDead = 0;
  let totalNoMatch = 0;

  const perProductReport = [];

  for (const r of productResults) {
    if (!r.ok) continue;
    const { data } = await jsonReq('GET', `/api/products/${r.productId}`, { token: user.token });
    const retailers = Array.isArray(data?.retailers) ? data.retailers : [];

    log(`${c.bold}${r.productName}${c.reset} ${c.dim}(${r.category})${c.reset}`);

    if (retailers.length === 0) {
      log(`  ${c.red}✗ No retailers populated${c.reset}\n`);
      perProductReport.push({ ...r, retailers: [], aliveCount: 0 });
      continue;
    }

    const checks = await Promise.all(
      retailers.map(async retailer => {
        const check = await checkRetailerUrl(retailer.product_url, r.productName);
        return { retailer, check };
      })
    );

    let aliveCount = 0;
    for (const { retailer, check } of checks) {
      totalRetailers++;
      const name = (retailer.retailer_name || 'Unknown').padEnd(22).slice(0, 22);
      if (!check.alive) {
        totalDead++;
        const reason = check.error || `HTTP ${check.status}`;
        log(`  ${c.red}✗${c.reset} ${name} ${c.red}DEAD${c.reset} ${c.dim}(${reason})${c.reset}`);
      } else if (!check.hasProductMatch) {
        totalAlive++;
        totalNoMatch++;
        log(`  ${c.yellow}⚠${c.reset} ${name} ${c.yellow}LIVE but product not found${c.reset} ${c.dim}(${check.matchCount}/${check.totalWords} words)${c.reset}`);
      } else {
        totalAlive++;
        aliveCount++;
        log(`  ${c.green}✓${c.reset} ${name} ${c.green}OK${c.reset} ${c.dim}(${check.matchCount}/${check.totalWords} words matched)${c.reset}`);
      }
    }
    perProductReport.push({ ...r, retailers, aliveCount });
    log('');
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  log(`${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`${c.bold}  Summary${c.reset}`);
  log(`${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`  Imports:           ${productResults.filter(r => r.ok).length}/${productResults.length}`);
  log(`  Total retailers:   ${totalRetailers}`);
  log(`  ${c.green}Alive:             ${totalAlive}${c.reset}`);
  log(`  ${c.red}Dead (4xx/5xx):    ${totalDead}${c.reset}`);
  log(`  ${c.yellow}Live but no match: ${totalNoMatch}${c.reset}`);

  const productsWithoutRetailers = perProductReport.filter(r => r.retailers?.length === 0);
  if (productsWithoutRetailers.length > 0) {
    log(`\n  ${c.red}Products with NO retailers populated:${c.reset}`);
    for (const r of productsWithoutRetailers) {
      log(`    - ${r.productName} (${r.category})`);
    }
  }

  log('');
  process.exit(totalDead > 0 ? 1 : 0);
}

main().catch(err => {
  log(`${c.red}Fatal: ${err.message}${c.reset}`);
  log(err.stack);
  process.exit(1);
});
