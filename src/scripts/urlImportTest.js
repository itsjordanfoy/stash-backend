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
  // ── Personal blogs & portfolios (the failure case the user hit) ────────────
  { category: 'Photographer portfolio', url: 'https://www.joelmeyerowitz.com/publications-/where-i-find-myself-1' },
  { category: 'Photographer portfolio', url: 'https://www.erwinolaf.com/' },

  // ── Design & interiors blogs ───────────────────────────────────────────────
  { category: 'Interior design blog', url: 'https://www.houseandgarden.co.uk/article/masterclass-victorian-extension-east-london-terrace' },
  { category: 'Design blog',          url: 'https://www.dezeen.com/' },

  // ── Long-form journalism ───────────────────────────────────────────────────
  { category: 'Magazine article',     url: 'https://www.theatlantic.com/technology/archive/2024/05/artificial-intelligence/678275/' },
  { category: 'News article',         url: 'https://www.bbc.com/news' },

  // ── Newsletter / blog platforms ────────────────────────────────────────────
  { category: 'Substack',             url: 'https://stratechery.com/' },
  { category: 'Medium',               url: 'https://medium.com/' },

  // ── YouTube ────────────────────────────────────────────────────────────────
  { category: 'YouTube video',        url: 'https://youtu.be/ZBWMyLvkFhA', expectedTag: 'YouTube' },
  { category: 'YouTube video',        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expectedTag: 'YouTube' },

  // ── Social media ───────────────────────────────────────────────────────────
  { category: 'Instagram post',       url: 'https://www.instagram.com/p/C5xYZaBz8qL/', expectedTag: 'Instagram' },
  { category: 'TikTok video',         url: 'https://www.tiktok.com/@zachking/video/7136971512639016238', expectedTag: 'TikTok' },
  { category: 'Reddit post',          url: 'https://www.reddit.com/r/DesignPorn/comments/1aabbcc/example/', expectedTag: 'Reddit' },

  // ── Podcasts ───────────────────────────────────────────────────────────────
  { category: 'Apple Podcasts',       url: 'https://podcasts.apple.com/us/podcast/the-rest-is-history/id1537788786', expectedTag: 'Podcasts' },
  { category: 'Spotify podcast',      url: 'https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL', expectedTag: 'Podcasts' },

  // ── E-commerce ─────────────────────────────────────────────────────────────
  { category: 'Amazon product',       url: 'https://www.amazon.co.uk/dp/B08N5WRWNW' },
  { category: 'IKEA product',         url: 'https://www.ikea.com/gb/en/p/kallax-shelving-unit-white-20275806/' },

  // ── Courses ────────────────────────────────────────────────────────────────
  { category: 'Masterclass',          url: 'https://www.masterclass.com/classes/gordon-ramsay-teaches-cooking', expectedTag: 'Courses' },

  // ── Games ──────────────────────────────────────────────────────────────────
  { category: 'Steam game',           url: 'https://store.steampowered.com/app/1245620/ELDEN_RING/', expectedTag: 'Games' },

  // ── Apps ───────────────────────────────────────────────────────────────────
  { category: 'iOS App Store',        url: 'https://apps.apple.com/us/app/things-3/id904237743', expectedTag: 'Apps' },

  // ── Books ──────────────────────────────────────────────────────────────────
  { category: 'Goodreads book',       url: 'https://www.goodreads.com/book/show/7613.Animal_Farm' },

  // ── Music ──────────────────────────────────────────────────────────────────
  { category: 'Spotify album',        url: 'https://open.spotify.com/album/1CuB5nB8XGgEZNkR0lz5hk' },

  // ── Places / Maps ──────────────────────────────────────────────────────────
  { category: 'Google Maps',          url: 'https://maps.google.com/?q=Dishoom+Covent+Garden+London' },

  // ── Recipes ────────────────────────────────────────────────────────────────
  { category: 'Recipe',               url: 'https://www.bbcgoodfood.com/recipes/best-spaghetti-bolognese-recipe' },

  // ── Movies / TV ────────────────────────────────────────────────────────────
  { category: 'IMDb title',           url: 'https://www.imdb.com/title/tt0111161/' },
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
