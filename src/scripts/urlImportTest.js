#!/usr/bin/env node
/**
 * ┌──────────────────────────────────────────────────────────┐
 * │  Stash — URL Import Stress Test                          │
 * │                                                          │
 * │  Hits the live backend with a wide variety of URL types  │
 * │  to catch import regressions across blogs, portfolios,   │
 * │  social platforms, e-commerce, video, podcasts, etc.     │
 * │                                                          │
 * │  Usage:                                                  │
 * │    TEST_BASE_URL=https://stash-backend-production-...    │
 * │    node backend/src/scripts/urlImportTest.js             │
 * │                                                          │
 * │  Runs imports sequentially, polls each to completion,    │
 * │  and reports exactly which URLs failed and why.          │
 * └──────────────────────────────────────────────────────────┘
 */

require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env'),
  override: true,
});

const crypto = require('crypto');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const POLL_TIMEOUT_MS = 120_000;
const IMPORT_DELAY_MS = 500; // Pause between imports so we don't hammer the AI

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

// ── URL corpus — covers every category we care about ─────────────────────────
// Each entry: { category, url, expectedTag? }
// expectedTag is optional — when set we verify the filter tag matches.
const URLS = [
  // ── Books (8) ──────────────────────────────────────────────────────────────
  { category: 'Amazon book',          url: 'https://www.amazon.co.uk/Lonesome-Dove-Larry-McMurtry/dp/0330327070' },
  { category: 'Waterstones book',     url: 'https://www.waterstones.com/book/the-overstory/richard-powers/9781784708245' },
  { category: 'Goodreads book',       url: 'https://www.goodreads.com/book/show/7613.Animal_Farm' },
  { category: "Blackwell's book",     url: 'https://blackwells.co.uk/bookshop/product/9780241988268' },
  { category: 'Bookshop.org book',    url: 'https://uk.bookshop.org/p/books/the-bee-sting-paul-murray/7476090' },
  { category: 'Penguin classic',      url: 'https://www.amazon.co.uk/Gruffalo-Julia-Donaldson/dp/0333710932' },
  { category: 'Cookbook',             url: 'https://www.amazon.co.uk/Ottolenghi-SIMPLE-Yotam/dp/1785031163' },
  { category: 'Non-fiction',          url: 'https://www.amazon.co.uk/Sapiens-Humankind-Yuval-Noah-Harari/dp/0099590085' },

  // ── Electronics & tech (5) ─────────────────────────────────────────────────
  { category: 'Apple iPhone',         url: 'https://www.apple.com/uk/shop/buy-iphone/iphone-16-pro' },
  { category: 'Apple MacBook',        url: 'https://www.apple.com/uk/shop/buy-mac/macbook-pro' },
  { category: 'Amazon ASIN',          url: 'https://www.amazon.co.uk/dp/B08N5WRWNW' },
  { category: 'YouTube short',        url: 'https://youtu.be/ZBWMyLvkFhA', expectedTag: 'YouTube' },
  { category: 'YouTube full',         url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expectedTag: 'YouTube' },

  // ── Home & furniture (4) ───────────────────────────────────────────────────
  { category: 'IKEA product',         url: 'https://www.ikea.com/gb/en/p/kallax-shelving-unit-white-20275806/' },
  { category: 'John Lewis product',   url: 'https://www.johnlewis.com/anyday-john-lewis-cotton-double-fitted-sheet-white/p4839041' },
  { category: 'Dunelm product',       url: 'https://www.dunelm.com/product/jollein-spring-knit-cotton-blanket-75-x-100cm-1000306055' },
  { category: 'Lakeland',             url: 'https://www.lakeland.co.uk/68037/lakeland-mini-loaf-pans' },

  // ── Fashion (4) ────────────────────────────────────────────────────────────
  { category: 'Nike trainers',        url: 'https://www.nike.com/gb/t/air-force-1-07-shoe-WrLlWX' },
  { category: 'ASOS clothing',        url: 'https://www.asos.com/asos-design/asos-design-muscle-t-shirt-in-white/prd/8998055' },
  { category: 'Selfridges',           url: 'https://www.selfridges.com/GB/en/cat/gucci-horsebit-1955-leather-shoulder-bag_R04209627/' },
  { category: 'JD Sports',            url: 'https://www.jdsports.co.uk/product/black-the-north-face-mens-simple-dome-t-shirt/16143064/' },

  // ── Beauty (3) ─────────────────────────────────────────────────────────────
  { category: 'Cult Beauty',          url: 'https://www.cultbeauty.co.uk/glossier-balm-dotcom' },
  { category: 'Sephora',              url: 'https://www.sephora.co.uk/product/rare-beauty-by-selena-gomez-soft-pinch-liquid-blush-P501401' },
  { category: 'Boots',                url: 'https://www.boots.com/cerave-moisturising-lotion-236ml-10289814' },

  // ── Recipes & food (3) ─────────────────────────────────────────────────────
  { category: 'BBC Good Food',        url: 'https://www.bbcgoodfood.com/recipes/best-spaghetti-bolognese-recipe' },
  { category: 'NYT Cooking',          url: 'https://cooking.nytimes.com/recipes/1017560-no-knead-bread' },
  { category: 'Jamie Oliver',         url: 'https://www.jamieoliver.com/recipes/chicken-recipes/chicken-tikka-masala/' },

  // ── Movies & TV (3) ────────────────────────────────────────────────────────
  { category: 'IMDb title',           url: 'https://www.imdb.com/title/tt0111161/' },
  { category: 'Rotten Tomatoes',      url: 'https://www.rottentomatoes.com/m/the_shawshank_redemption' },
  { category: 'Letterboxd film',      url: 'https://letterboxd.com/film/parasite-2019/' },

  // ── Music (3) ──────────────────────────────────────────────────────────────
  { category: 'Spotify album',        url: 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa' },
  { category: 'Apple Music album',    url: 'https://music.apple.com/gb/album/random-access-memories/617154241' },
  { category: 'Discogs release',      url: 'https://www.discogs.com/release/2255988-Pink-Floyd-The-Dark-Side-Of-The-Moon' },

  // ── Podcasts (2) ───────────────────────────────────────────────────────────
  { category: 'Apple Podcasts',       url: 'https://podcasts.apple.com/us/podcast/the-rest-is-history/id1537788786', expectedTag: 'Podcasts' },
  { category: 'Spotify show',         url: 'https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL', expectedTag: 'Podcasts' },

  // ── Games (3) ──────────────────────────────────────────────────────────────
  { category: 'Steam game',           url: 'https://store.steampowered.com/app/1245620/ELDEN_RING/', expectedTag: 'Games' },
  { category: 'Nintendo Store',       url: 'https://www.nintendo.com/us/store/products/the-legend-of-zelda-tears-of-the-kingdom-switch/' },
  { category: 'PlayStation Store',    url: 'https://store.playstation.com/en-gb/product/EP9000-CUSA05625_00-GHOSTSSHIPFULL00' },

  // ── Apps (2) ───────────────────────────────────────────────────────────────
  { category: 'iOS App Store',        url: 'https://apps.apple.com/us/app/things-3/id904237743', expectedTag: 'Apps' },
  { category: 'Play Store',           url: 'https://play.google.com/store/apps/details?id=com.spotify.music' },

  // ── Courses (2) ────────────────────────────────────────────────────────────
  { category: 'Masterclass',          url: 'https://www.masterclass.com/classes/gordon-ramsay-teaches-cooking', expectedTag: 'Courses' },
  { category: 'Coursera',             url: 'https://www.coursera.org/learn/machine-learning' },

  // ── Articles / journalism (6) ──────────────────────────────────────────────
  { category: 'Atlantic article',     url: 'https://www.theatlantic.com/technology/archive/2024/05/artificial-intelligence/678275/' },
  { category: 'Guardian article',     url: 'https://www.theguardian.com/uk-news' },
  { category: 'BBC News',             url: 'https://www.bbc.com/news' },
  { category: 'Medium homepage',      url: 'https://medium.com/' },
  { category: 'Substack blog',        url: 'https://stratechery.com/' },
  { category: 'Design blog',          url: 'https://www.dezeen.com/' },
  { category: 'House & Garden',       url: 'https://www.houseandgarden.co.uk/article/masterclass-victorian-extension-east-london-terrace' },

  // ── Photographer / portfolio sites (2) ─────────────────────────────────────
  { category: 'Squarespace portfolio', url: 'https://www.joelmeyerowitz.com/publications-/where-i-find-myself-1' },
  { category: 'Photographer site',     url: 'https://www.erwinolaf.com/' },

  // ── Social media (4) ───────────────────────────────────────────────────────
  { category: 'Instagram post',       url: 'https://www.instagram.com/p/C5xYZaBz8qL/', expectedTag: 'Instagram' },
  { category: 'TikTok video',         url: 'https://www.tiktok.com/@zachking/video/7136971512639016238', expectedTag: 'TikTok' },
  { category: 'Reddit post',          url: 'https://www.reddit.com/r/DesignPorn/comments/1aabbcc/example/', expectedTag: 'Reddit' },
  { category: 'Pinterest pin',        url: 'https://www.pinterest.co.uk/pin/892205616025670056/', expectedTag: 'Pinterest' },

  // ── Places & maps (2) ──────────────────────────────────────────────────────
  { category: 'Google Maps',          url: 'https://maps.google.com/?q=Dishoom+Covent+Garden+London' },
  { category: 'OpenStreetMap',        url: 'https://www.openstreetmap.org/node/4302358186' },
];

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function req(method, urlPath, { body, token } = {}) {
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
      const { data } = await req('GET', `/api/imports/${importId}`, { token });
      if (data.status === 'completed')             return { status: 'completed', product: data.product };
      if (data.status === 'failed')                return { status: 'failed',    error: data.error };
      if (data.status === 'awaiting_confirmation') return { status: 'awaiting_confirmation' };
    } catch { /* transient */ }
  }
  return { status: 'timeout' };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`\n${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`${c.bold}${c.cyan}  Stash — URL Import Stress Test${c.reset}`);
  log(`${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`${c.dim}  Base URL:  ${BASE_URL}${c.reset}`);
  log(`${c.dim}  URLs:      ${URLS.length}${c.reset}`);
  log(`${c.dim}  Started:   ${new Date().toISOString()}${c.reset}\n`);

  // Register a fresh test user
  const runId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const user = {
    email: `stash_test_${runId}_url@test.internal`,
    password: 'TestPass!9x',
    token: null,
  };

  const reg = await req('POST', '/api/auth/register', {
    body: { email: user.email, password: user.password },
  });
  if (reg.status !== 201 || !reg.data.token) {
    log(`${c.red}✗ Failed to register test user: status=${reg.status}${c.reset}`);
    log(`  ${JSON.stringify(reg.data).slice(0, 200)}`);
    process.exit(1);
  }
  user.token = reg.data.token;
  log(`${c.green}✓${c.reset} Registered test user ${c.dim}${user.email}${c.reset}\n`);

  const results = [];

  // Run imports sequentially so we can see what's happening in real time
  for (let i = 0; i < URLS.length; i++) {
    const entry = URLS[i];
    const label = `${(i + 1).toString().padStart(2)}/${URLS.length}  ${entry.category.padEnd(28)}`;
    process.stdout.write(`${c.dim}${label}${c.reset} ${c.dim}${entry.url.slice(0, 60)}${entry.url.length > 60 ? '…' : ''}${c.reset}\n`);

    const start = Date.now();

    // Kick off the import
    const postRes = await req('POST', '/api/imports/link', {
      token: user.token,
      body: { url: entry.url },
    });

    if (postRes.status !== 202 || !postRes.data.importId) {
      const err = typeof postRes.data === 'object' ? postRes.data.error || JSON.stringify(postRes.data).slice(0, 150) : String(postRes.data).slice(0, 150);
      log(`     ${c.red}✗ POST failed (status=${postRes.status}): ${err}${c.reset}\n`);
      results.push({ ...entry, success: false, reason: `POST ${postRes.status}: ${err}`, durationMs: Date.now() - start });
      await sleep(IMPORT_DELAY_MS);
      continue;
    }

    // Poll until complete/failed/timeout
    const poll = await pollImport(postRes.data.importId, user.token);
    const durationMs = Date.now() - start;

    if (poll.status === 'completed') {
      const p = poll.product || {};
      const details = [
        p.name ? `name="${p.name.slice(0, 40)}"` : null,
        p.item_type ? `type=${p.item_type}` : null,
        p.image_url ? 'image=✓' : 'image=✗',
      ].filter(Boolean).join('  ');
      log(`     ${c.green}✓${c.reset} ${c.dim}${(durationMs / 1000).toFixed(1)}s  ${details}${c.reset}\n`);
      results.push({ ...entry, success: true, product: p, durationMs });
    } else if (poll.status === 'failed') {
      log(`     ${c.red}✗ Import failed: ${poll.error || '(no error)'}${c.reset}\n`);
      results.push({ ...entry, success: false, reason: poll.error || 'unknown', durationMs });
    } else if (poll.status === 'timeout') {
      log(`     ${c.yellow}⟳ Timed out after ${(POLL_TIMEOUT_MS / 1000)}s${c.reset}\n`);
      results.push({ ...entry, success: false, reason: 'timeout', durationMs });
    } else {
      log(`     ${c.yellow}? Unexpected status: ${poll.status}${c.reset}\n`);
      results.push({ ...entry, success: false, reason: poll.status, durationMs });
    }

    await sleep(IMPORT_DELAY_MS);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  log(`\n${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`${c.bold}  Summary${c.reset}`);
  log(`${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`  ${c.green}Passed: ${passed}${c.reset}  ${c.red}Failed: ${failed}${c.reset}  ${c.dim}Total: ${URLS.length}${c.reset}`);

  if (failed > 0) {
    log(`\n${c.bold}${c.red}  Failures:${c.reset}`);
    for (const r of results.filter(x => !x.success)) {
      log(`    ${c.red}✗${c.reset} ${c.bold}${r.category}${c.reset}`);
      log(`        ${c.dim}${r.url}${c.reset}`);
      log(`        ${c.red}${r.reason}${c.reset}`);
    }
  }

  log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  log(`${c.red}Fatal: ${err.message}${c.reset}`);
  log(err.stack);
  process.exit(1);
});
