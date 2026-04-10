#!/usr/bin/env node
/**
 * ┌─────────────────────────────────────────────────────────┐
 * │  Stash — Nightly Backend Test Suite                     │
 * │                                                         │
 * │  Runs against the live backend (localhost:3000 by       │
 * │  default; set TEST_BASE_URL to override).               │
 * │                                                         │
 * │  Usage:                                                 │
 * │    node backend/src/scripts/testSuite.js                │
 * │    node backend/src/scripts/testSuite.js --json         │
 * │    TEST_BASE_URL=https://api.stash.app node ...         │
 * │                                                         │
 * │  Exit code: 0 = all passed, 1 = failures present        │
 * │                                                         │
 * │  Output includes a PM-friendly summary block between    │
 * │  ===== PM SUMMARY START ===== / END markers so the      │
 * │  scheduled task can surface it cleanly in chat.         │
 * └─────────────────────────────────────────────────────────┘
 */

require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env'),
  override: true,
});

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const BASE_URL   = process.env.TEST_BASE_URL || 'http://localhost:3000';
const JSON_MODE  = process.argv.includes('--json');
const LOG_DIR    = path.resolve(__dirname, '../../logs');
const TS         = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE   = path.join(LOG_DIR, `test-${TS}.log`);
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};
const noColor = JSON_MODE || !process.stdout.isTTY;
const c = noColor
  ? Object.fromEntries(Object.keys(C).map(k => [k, '']))
  : C;

// ── State ─────────────────────────────────────────────────────────────────────
let passed   = 0;
let failed   = 0;
let skipped  = 0;
const results = [];
const logLines = [];
let currentSection = 'General';

// Severity mapping per section — governs the PM summary priority ordering.
// critical = blocks deploy, degraded = ship with warning, minor = backlog
const SECTION_SEVERITY = {
  'Health':                  'degraded',
  'Auth':                    'critical',
  'Products — empty state':  'degraded',
  'Import — link':           'degraded',
  'Fixtures — alt paths':    'degraded',
  'Products — post-import':  'degraded',
  'Two-user isolation':      'critical',
  'Boards':                  'degraded',
  'Search':                  'degraded',
  'Notifications':           'minor',
  'Subscriptions':           'minor',
  'Social URL handling':     'minor',
  'URL stress — real-world URLs': 'degraded',
  'Cleanup':                 'minor',
};

function emit(line) {
  console.log(line);
  logLines.push(line.replace(/\x1b\[[0-9;]*m/g, '')); // strip ANSI for log file
}

function section(name) {
  currentSection = name;
  emit(`\n${c.bold}${c.cyan}▸ ${name}${c.reset}`);
}

function pass(name, detail = '') {
  passed++;
  results.push({ status: 'pass', name, section: currentSection });
  emit(`  ${c.green}✓${c.reset} ${name}${detail ? `  ${c.dim}${detail}${c.reset}` : ''}`);
}

function fail(name, reason = '') {
  failed++;
  results.push({
    status: 'fail',
    name,
    reason,
    section: currentSection,
    severity: SECTION_SEVERITY[currentSection] || 'degraded',
  });
  emit(`  ${c.red}✗${c.reset} ${name}`);
  if (reason) emit(`    ${c.dim}↳ ${reason}${c.reset}`);
}

function skip(name, reason = '') {
  skipped++;
  results.push({ status: 'skip', name, reason, section: currentSection });
  emit(`  ${c.yellow}⟳${c.reset} ${name}  ${c.dim}(skipped: ${reason})${c.reset}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function req(method, urlPath, { body, token, expectStatus } = {}) {
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

  const expectedStatus = expectStatus ?? (method === 'POST' ? [200, 201, 202] : [200]);
  const okCodes = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const ok = okCodes.includes(res.status);

  return { status: res.status, data, ok };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollImport(importId, token, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    await sleep(2500);
    attempt++;
    try {
      const { data } = await req('GET', `/api/imports/${importId}`, { token });
      if (data.status === 'completed')              return { status: 'completed',              productId: data.product?.id };
      if (data.status === 'failed')                 return { status: 'failed',                 error: data.error };
      if (data.status === 'awaiting_confirmation')  return { status: 'awaiting_confirmation',  suggestions: data.suggestions };
    } catch { /* transient — keep polling */ }
    if (attempt % 4 === 0) emit(`    ${c.dim}  … still processing (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)${c.reset}`);
  }
  return { status: 'timeout' };
}

// ── Admin cleanup helper ──────────────────────────────────────────────────────
// Non-fatal: if the endpoint is missing or errors, log a warning and continue.
// The endpoint only deletes accounts matching stash_test_%@test.internal older
// than the given window, so it's structurally incapable of touching real data.
async function cleanupTestUsers(olderThanMinutes, label) {
  if (!ADMIN_SECRET) {
    emit(`  ${c.dim}(cleanup skipped: no ADMIN_SECRET)${c.reset}`);
    return { skipped: true };
  }
  try {
    const res = await fetch(`${BASE_URL}/admin/cleanup-test-users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      body: JSON.stringify({ olderThanMinutes }),
    });
    if (!res.ok) {
      emit(`  ${c.yellow}⟳${c.reset} Cleanup (${label}) warning: status=${res.status}`);
      return { warning: true };
    }
    const data = await res.json();
    emit(`  ${c.dim}Cleanup (${label}): deleted=${data.deleted ?? 0}${c.reset}`);
    return data;
  } catch (err) {
    emit(`  ${c.yellow}⟳${c.reset} Cleanup (${label}) warning: ${err.message}`);
    return { warning: true, error: err.message };
  }
}

// ── Unique test identity ──────────────────────────────────────────────────────
const RUN_ID = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
const userA = {
  email: `stash_test_${RUN_ID}_A@test.internal`,
  password: 'TestPass!9x',
  token: null,
  id: null,
};
const userB = {
  email: `stash_test_${RUN_ID}_B@test.internal`,
  password: 'TestPass!9x',
  token: null,
  id: null,
};

// ── Register helper (used for both users) ────────────────────────────────────
async function registerUser(user, label) {
  const { data, ok, status } = await req('POST', '/api/auth/register', {
    body: { email: user.email, password: user.password, displayName: `Test Runner ${label}` },
    expectStatus: 201,
  });
  if (ok && data.token) {
    user.token = data.token;
    user.id = data.user?.id;
    pass(`POST /api/auth/register [${label}] → 201`, `userId=${user.id?.slice(0, 8)}…`);
    return true;
  }
  fail(`POST /api/auth/register [${label}]`, `status=${status} — ${JSON.stringify(data).slice(0, 120)}`);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  emit(`\n${c.bold}${c.white}╔═══════════════════════════════════════════╗${c.reset}`);
  emit(`${c.bold}${c.white}║  Stash Backend Test Suite — ${new Date().toUTCString().slice(0,16)}  ║${c.reset}`);
  emit(`${c.bold}${c.white}╚═══════════════════════════════════════════╝${c.reset}`);
  emit(`${c.dim}  Target : ${BASE_URL}${c.reset}`);
  emit(`${c.dim}  UserA  : ${userA.email}${c.reset}`);
  emit(`${c.dim}  UserB  : ${userB.email}${c.reset}`);

  // Pre-run cleanup — purge any stash_test_* users older than 5 min from
  // crashed prior runs. Non-fatal if the endpoint isn't available.
  emit(`\n${c.dim}Pre-run cleanup…${c.reset}`);
  await cleanupTestUsers(5, 'pre-run');

  let productId = null;          // user A's imported product
  let boardId   = null;          // user A's test board
  let productName = '';          // for deep validation reuse

  // ── 1. Health ──────────────────────────────────────────────────────────────
  section('Health');
  try {
    const { data, ok } = await req('GET', '/health');
    ok && data.status === 'ok'
      ? pass('GET /health', `uptime ${data.uptime ?? '—'}`)
      : fail('GET /health', `status=${data?.status}, response=${JSON.stringify(data)}`);
  } catch (e) { fail('GET /health', e.message); }

  // ── 2. Auth ────────────────────────────────────────────────────────────────
  section('Auth');

  // Register both users up front. UserA is the primary; UserB exists for
  // the isolation tests later.
  const userARegistered = await registerUser(userA, 'A');
  if (!userARegistered) {
    emit(`\n${c.red}${c.bold}  Cannot continue without userA token.${c.reset}\n`);
    return;
  }
  const userBRegistered = await registerUser(userB, 'B');
  if (!userBRegistered) {
    emit(`\n${c.red}${c.bold}  userB registration failed — isolation tests will be skipped.${c.reset}\n`);
  }

  // Login (userA)
  try {
    const { data, ok, status } = await req('POST', '/api/auth/login', {
      body: { email: userA.email, password: userA.password },
    });
    ok && data.token
      ? pass('POST /api/auth/login → 200')
      : fail('POST /api/auth/login', `status=${status}`);
  } catch (e) { fail('POST /api/auth/login', e.message); }

  // Wrong password
  try {
    const { status } = await req('POST', '/api/auth/login', {
      body: { email: userA.email, password: 'WrongPassword1' },
      expectStatus: 401,
    });
    status === 401 ? pass('Wrong password → 401') : fail('Wrong password rejection', `got ${status}`);
  } catch (e) { fail('Wrong password rejection', e.message); }

  // No token → 401
  try {
    const { status } = await req('GET', '/api/users/me', { expectStatus: 401 });
    status === 401 ? pass('No auth token → 401') : fail('No auth token rejection', `got ${status}`);
  } catch (e) { fail('No auth token rejection', e.message); }

  // GET /api/users/me (backend lowercases emails, compare accordingly)
  try {
    const { data, ok } = await req('GET', '/api/users/me', { token: userA.token });
    ok && data.email?.toLowerCase() === userA.email.toLowerCase()
      ? pass('GET /api/users/me')
      : fail('GET /api/users/me', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/users/me', e.message); }

  // GET /api/users/me/stats
  try {
    const { data, ok } = await req('GET', '/api/users/me/stats', { token: userA.token });
    ok ? pass('GET /api/users/me/stats') : fail('GET /api/users/me/stats', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/users/me/stats', e.message); }

  // ── 3. Products — empty state ──────────────────────────────────────────────
  section('Products — empty state');

  try {
    const { data, ok } = await req('GET', '/api/products/recent?limit=20', { token: userA.token });
    ok && Array.isArray(data.products) && data.products.length === 0
      ? pass('GET /api/products/recent → empty array')
      : fail('GET /api/products/recent (empty)', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/products/recent (empty)', e.message); }

  try {
    const { data, ok } = await req('GET', '/api/products/search?q=chair', { token: userA.token });
    ok && Array.isArray(data.products)
      ? pass('GET /api/products/search (empty)', `${data.products.length} results`)
      : fail('GET /api/products/search (empty)', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/products/search (empty)', e.message); }

  // 404 for unknown product
  try {
    const { status } = await req('GET', '/api/products/00000000-0000-0000-0000-000000000000', {
      token: userA.token, expectStatus: 404,
    });
    status === 404 ? pass('GET /api/products/:id unknown → 404') : fail('Unknown product 404', `got ${status}`);
  } catch (e) { fail('Unknown product 404', e.message); }

  // ── 4. Imports ─────────────────────────────────────────────────────────────
  section('Import — link');

  // Missing URL body
  try {
    const { status } = await req('POST', '/api/imports/link', { token: userA.token, body: {}, expectStatus: 400 });
    status === 400 ? pass('Missing URL → 400') : fail('Missing URL rejection', `got ${status}`);
  } catch (e) { fail('Missing URL rejection', e.message); }

  // Invalid URL
  try {
    const { status } = await req('POST', '/api/imports/link', {
      token: userA.token, body: { url: 'not-a-real-url' }, expectStatus: 400,
    });
    status === 400 ? pass('Invalid URL format → 400') : fail('Invalid URL rejection', `got ${status}`);
  } catch (e) { fail('Invalid URL rejection', e.message); }

  // Real product import using self-hosted fixture (no external dependency)
  const IMPORT_URL = `${BASE_URL}/test-fixtures/kallax.html`;
  let importId = null;
  try {
    const { data, ok, status } = await req('POST', '/api/imports/link', {
      token: userA.token,
      body: { url: IMPORT_URL },
      expectStatus: 202,
    });
    if (ok && data.importId) {
      importId = data.importId;
      pass(`POST /api/imports/link → 202`, `fixture kallax.html, importId=${importId.slice(0, 8)}…`);
    } else {
      fail('POST /api/imports/link', `status=${status} — ${JSON.stringify(data).slice(0, 120)}`);
    }
  } catch (e) { fail('POST /api/imports/link', e.message); }

  // GET /api/imports/:id — immediate status check (should be processing)
  if (importId) {
    try {
      const { data, ok } = await req('GET', `/api/imports/${importId}`, { token: userA.token });
      ok && ['processing', 'pending', 'completed'].includes(data.status)
        ? pass(`GET /api/imports/:id → status="${data.status}"`)
        : fail('GET /api/imports/:id', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('GET /api/imports/:id', e.message); }
  }

  // Poll until completed / awaiting confirmation
  if (importId) {
    emit(`\n  ${c.dim}  Polling import (up to 90s)…${c.reset}`);
    try {
      const result = await pollImport(importId, userA.token);
      switch (result.status) {
        case 'completed':
          if (result.productId) {
            productId = result.productId;
            pass('Import completed', `productId=${productId.slice(0, 8)}…`);
          } else {
            fail('Import completed but no productId');
          }
          break;

        case 'awaiting_confirmation': {
          const suggestion = result.suggestions?.[0];
          if (suggestion) {
            const { data, ok } = await req('POST', `/api/imports/${importId}/confirm`, {
              token: userA.token,
              body: { productData: suggestion },
            });
            if (ok && data.productId) {
              productId = data.productId;
              pass('Import confirmed (awaiting_confirmation path)', `productId=${productId.slice(0, 8)}…`);
            } else {
              fail('Import confirmation', JSON.stringify(data).slice(0, 120));
            }
          } else {
            fail('Import awaiting_confirmation', 'No suggestions returned');
          }
          break;
        }

        case 'failed':
          fail('Import failed', result.error ?? 'unknown error');
          break;

        case 'timeout':
          fail('Import timed out', 'Exceeded 90s');
          break;
      }
    } catch (e) { fail('Import polling', e.message); }
  }

  // ── 4b. Alternative fixture paths ──────────────────────────────────────────
  // Exercise the JSON-LD, minimal, and broken fallback paths of the scraper.
  section('Fixtures — alt paths');

  async function importAndAwait(url, label, { allowStatuses = ['completed', 'awaiting_confirmation'] } = {}) {
    try {
      const { data, ok, status } = await req('POST', '/api/imports/link', {
        token: userA.token,
        body: { url },
        expectStatus: 202,
      });
      if (!ok || !data.importId) {
        fail(`Import ${label}`, `accept status=${status}, body=${JSON.stringify(data).slice(0, 120)}`);
        return null;
      }
      const result = await pollImport(data.importId, userA.token);
      if (allowStatuses.includes(result.status)) {
        pass(`Import ${label} → ${result.status}`);
        return result;
      }
      fail(`Import ${label} ended in ${result.status}`, result.error ?? '');
      return null;
    } catch (e) {
      fail(`Import ${label}`, e.message);
      return null;
    }
  }

  await importAndAwait(`${BASE_URL}/test-fixtures/chair-jsonld.html`, 'chair-jsonld');
  await importAndAwait(`${BASE_URL}/test-fixtures/minimal.html`, 'minimal', {
    allowStatuses: ['completed', 'awaiting_confirmation', 'failed'],
  });
  // broken.html — the ONLY unacceptable outcome is a server crash/timeout.
  // failed / completed / awaiting_confirmation are all fine.
  await importAndAwait(`${BASE_URL}/test-fixtures/broken.html`, 'broken (malformed)', {
    allowStatuses: ['completed', 'awaiting_confirmation', 'failed'],
  });

  // ── 5. Products — post-import + deep validation ───────────────────────────
  section('Products — post-import');

  if (!productId) {
    skip('All post-import product tests', 'import did not produce a productId');
  } else {
    // Recent list includes new product
    try {
      const { data, ok } = await req('GET', '/api/products/recent?limit=20', { token: userA.token });
      if (ok && data.products?.some(p => p.id === productId)) {
        pass('GET /api/products/recent — new product present');
      } else if (ok) {
        fail('GET /api/products/recent', 'New product not in recent list (cache issue?)');
      } else {
        fail('GET /api/products/recent', JSON.stringify(data).slice(0, 120));
      }
    } catch (e) { fail('GET /api/products/recent (post-import)', e.message); }

    // Deep data validation
    try {
      const { data, ok } = await req('GET', `/api/products/${productId}`, { token: userA.token });
      if (ok && data.id === productId) {
        productName = data.name ?? '';
        pass(`GET /api/products/:id`, `"${productName.slice(0, 40)}"`);

        // Name present
        if (productName && productName.trim().length > 0) {
          pass('Deep: product.name present');
        } else {
          fail('Deep: product.name missing or empty');
        }

        // Retailers array shape. The API returns `current_price` and
        // `product_url` (not `price` / `url`).
        if (Array.isArray(data.retailers) && data.retailers.length >= 1) {
          pass(`Deep: product.retailers present (${data.retailers.length})`);

          const r0 = data.retailers[0];

          // Price > 0 — current_price can come back as a string or float
          const rawPrice = r0.current_price ?? r0.price;
          const price = typeof rawPrice === 'string' ? parseFloat(rawPrice) : rawPrice;
          if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
            pass(`Deep: retailer current_price > 0 (${price})`);
          } else {
            fail('Deep: retailer current_price invalid or ≤ 0', `current_price=${rawPrice}`);
          }

          // Currency ISO code
          if (typeof r0.currency === 'string' && /^[A-Z]{3}$/.test(r0.currency)) {
            pass(`Deep: retailer currency is ISO (${r0.currency})`);
          } else {
            fail('Deep: retailer currency not ISO-3', `currency=${r0.currency}`);
          }

          // Retailer URL contains BASE_URL host (same origin as fixture)
          const rUrl = r0.product_url ?? r0.url;
          if (typeof rUrl === 'string' && rUrl.length > 0) {
            try {
              const retailerHost = new URL(rUrl).host;
              const baseHost = new URL(BASE_URL).host;
              if (retailerHost === baseHost || rUrl.includes(baseHost)) {
                pass(`Deep: retailer product_url on fixture host (${retailerHost})`);
              } else {
                fail('Deep: retailer product_url host mismatch', `${retailerHost} vs ${baseHost}`);
              }
            } catch {
              fail('Deep: retailer product_url not parseable', rUrl);
            }
          } else {
            fail('Deep: retailer product_url missing');
          }
        } else {
          fail('Deep: product.retailers missing or empty');
        }

        // Image URL liveness (optional — null is acceptable).
        // Workaround: the scraper occasionally stores https://localhost... for
        // fixture images resolved from relative paths. localhost has no HTTPS
        // listener, so we downgrade to http for the HEAD check. This is a
        // fixture-specific adjustment; real URLs are fetched as-is.
        if (data.image_url) {
          let probeUrl = data.image_url;
          if (probeUrl.startsWith('https://localhost')) {
            probeUrl = probeUrl.replace('https://localhost', 'http://localhost');
          }
          try {
            const headRes = await fetch(probeUrl, { method: 'HEAD' });
            const ct = headRes.headers.get('content-type') ?? '';
            if (headRes.status === 200 && ct.startsWith('image/')) {
              pass(`Deep: image_url HEAD 200 (${ct.split(';')[0]})`);
            } else {
              fail('Deep: image_url HEAD failed', `status=${headRes.status}, ct=${ct}`);
            }
          } catch (e) {
            fail('Deep: image_url fetch error', `${e.message} (url=${probeUrl})`);
          }
        } else {
          emit(`    ${c.dim}(image_url is null — skipping HEAD check)${c.reset}`);
        }
      } else {
        fail('GET /api/products/:id', JSON.stringify(data).slice(0, 120));
      }
    } catch (e) { fail('GET /api/products/:id', e.message); }

    // GET /api/products/search — should surface the new product
    try {
      const q = encodeURIComponent(productName.split(' ')[0] || 'KALLAX');
      const { data, ok } = await req('GET', `/api/products/search?q=${q}`, { token: userA.token });
      ok && Array.isArray(data.products)
        ? pass(`GET /api/products/search?q=${q}`, `${data.products.length} result(s)`)
        : fail('GET /api/products/search', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('GET /api/products/search', e.message); }

    // PATCH notes — with read-after-write verification
    const TEST_NOTE = 'Automated test note — safe to delete.';
    try {
      const { ok, status } = await req('PATCH', `/api/products/${productId}/notes`, {
        token: userA.token, body: { notes: TEST_NOTE },
      });
      if (!ok) {
        fail('PATCH notes', `status=${status}`);
      } else {
        pass('PATCH /api/products/:id/notes');
        // Read-after-write
        const { data: after, ok: getOk } = await req('GET', `/api/products/${productId}`, { token: userA.token });
        if (getOk && after.notes === TEST_NOTE) {
          pass('Read-after-write: notes saved correctly');
        } else {
          fail('Read-after-write: notes not persisted', `expected="${TEST_NOTE}", got="${after.notes}"`);
        }
      }
    } catch (e) { fail('PATCH notes', e.message); }

    // Clear notes + read-after-write
    try {
      const { ok } = await req('PATCH', `/api/products/${productId}/notes`, {
        token: userA.token, body: { notes: '' },
      });
      if (!ok) {
        fail('PATCH notes (clear)', 'failed');
      } else {
        pass('PATCH /api/products/:id/notes (clear)');
        const { data: after } = await req('GET', `/api/products/${productId}`, { token: userA.token });
        if (after.notes === '' || after.notes === null || after.notes === undefined) {
          pass('Read-after-write: notes cleared');
        } else {
          fail('Read-after-write: notes not cleared', `got="${after.notes}"`);
        }
      }
    } catch (e) { fail('PATCH notes (clear)', e.message); }

    // POST /api/products/:id/auto-board — with read-after-write
    try {
      const { data, ok } = await req('POST', `/api/products/${productId}/auto-board`, {
        token: userA.token, body: {},
      });
      if (!ok) {
        fail('POST auto-board', JSON.stringify(data).slice(0, 120));
      } else {
        const suggestedBoardId = data.board?.id;
        pass('POST /api/products/:id/auto-board', `suggestion="${data.board?.name ?? 'none'}"`);
        // Read-after-write: verify the product is actually in the board
        if (suggestedBoardId) {
          const { data: boardData, ok: getOk } = await req('GET', `/api/boards/${suggestedBoardId}`, { token: userA.token });
          if (getOk && boardData.products?.some(p => p.id === productId)) {
            pass('Read-after-write: auto-board added product');
          } else {
            fail('Read-after-write: auto-board did not add product', `board products=${JSON.stringify(boardData.products?.map(p => p.id))}`);
          }
        }
      }
    } catch (e) { fail('POST auto-board', e.message); }

    // POST /api/products/:id/ask — SSE streaming (DEEP validation)
    try {
      const res = await fetch(`${BASE_URL}/api/products/${productId}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ question: 'What is this product used for?' }),
        signal: AbortSignal.timeout(45_000),
      });

      if (res.status === 200 && res.headers.get('content-type')?.includes('text/event-stream')) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';
        let contentAccumulated = '';
        let done = false;
        let sawDone = false;

        while (!done) {
          const { value, done: d } = await reader.read();
          done = d;
          if (value) {
            raw += decoder.decode(value, { stream: true });
            // Extract content tokens from SSE frames
            const frames = raw.split('\n\n');
            raw = frames.pop() || '';
            for (const frame of frames) {
              const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
              if (!dataLine) continue;
              const payload = dataLine.slice(6).trim();
              if (payload === '[DONE]') {
                sawDone = true;
                continue;
              }
              try {
                const obj = JSON.parse(payload);
                // The aiService emits { token: "..." } per chunk (see
                // services/aiService.js:764). Fall back to other common
                // field names for resilience if the format changes.
                if (typeof obj.token === 'string') contentAccumulated += obj.token;
                else if (typeof obj.content === 'string') contentAccumulated += obj.content;
                else if (typeof obj.delta === 'string') contentAccumulated += obj.delta;
                else if (obj.text) contentAccumulated += String(obj.text);
              } catch { /* malformed frame, ignore */ }
            }
          }
        }

        pass('POST /api/products/:id/ask — SSE opened');

        if (sawDone) {
          pass('SSE: [DONE] sentinel received');
        } else {
          fail('SSE: [DONE] sentinel missing', 'stream ended without [DONE]');
        }

        if (contentAccumulated.length > 50) {
          pass(`SSE: meaningful content (${contentAccumulated.length} chars)`);
        } else {
          fail('SSE: content too short', `got ${contentAccumulated.length} chars: "${contentAccumulated.slice(0, 120)}"`);
        }

        // Sanity: response mentions at least one word from the product name
        const nameWords = productName.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
        const answerLower = contentAccumulated.toLowerCase();
        const hasNameWord = nameWords.some(w => answerLower.includes(w));
        if (nameWords.length === 0 || hasNameWord) {
          pass('SSE: answer references product name');
        } else {
          // Non-fatal warning — the AI may paraphrase.
          emit(`    ${c.yellow}⟳${c.reset} SSE: answer did not mention product name (soft warning)`);
        }
      } else {
        const text = await res.text().catch(() => '');
        fail('POST /api/products/:id/ask', `status=${res.status}, content-type=${res.headers.get('content-type')}, body=${text.slice(0, 120)}`);
      }
    } catch (e) { fail('POST /api/products/:id/ask', e.message); }

    // POST /api/products/:id/ask — missing question → 400
    try {
      const { status } = await req('POST', `/api/products/${productId}/ask`, {
        token: userA.token, body: {}, expectStatus: 400,
      });
      status === 400 ? pass('POST ask missing question → 400') : fail('Ask missing question', `got ${status}`);
    } catch (e) { fail('Ask missing question', e.message); }

    // GET /api/prices/:id/history
    try {
      const { data, ok } = await req('GET', `/api/prices/${productId}/history`, { token: userA.token });
      ok
        ? pass('GET /api/prices/:id/history', `${data.history?.length ?? 0} data point(s)`)
        : fail('GET /api/prices/:id/history', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('GET /api/prices/:id/history', e.message); }

    // Enable / disable price tracking
    try {
      const { ok: trackOk } = await req('POST', `/api/prices/${productId}/track`, { token: userA.token, body: {} });
      trackOk ? pass('POST /api/prices/:id/track (enable)') : fail('POST price track enable', 'failed');

      const { ok: untrackOk } = await req('DELETE', `/api/prices/${productId}/track`, { token: userA.token, expectStatus: 200 });
      untrackOk ? pass('DELETE /api/prices/:id/track (disable)') : fail('DELETE price track disable', 'failed');
    } catch (e) { fail('Price tracking', e.message); }
  }

  // ── 5b. Two-user isolation ────────────────────────────────────────────────
  section('Two-user isolation');

  if (!productId || !userB.token) {
    skip('All isolation tests', !productId ? 'no productId' : 'userB not registered');
  } else {
    // userB recent list must not contain userA's product
    try {
      const { data, ok } = await req('GET', '/api/products/recent?limit=20', { token: userB.token });
      if (ok && !data.products?.some(p => p.id === productId)) {
        pass('userB GET /api/products/recent — userA product NOT visible');
      } else if (ok) {
        fail('Isolation: userB sees userA product in recent list', `products=${JSON.stringify(data.products?.map(p => p.id))}`);
      } else {
        fail('userB GET /api/products/recent', JSON.stringify(data).slice(0, 120));
      }
    } catch (e) { fail('userB GET /api/products/recent', e.message); }

    // userB search must not contain userA's product
    try {
      const q = encodeURIComponent(productName.split(' ')[0] || 'KALLAX');
      const { data, ok } = await req('GET', `/api/products/search?q=${q}`, { token: userB.token });
      if (ok && !data.products?.some(p => p.id === productId)) {
        pass('userB GET /api/products/search — userA product NOT in results');
      } else if (ok) {
        fail('Isolation: userB search surfaces userA product', `products=${JSON.stringify(data.products?.map(p => p.id))}`);
      } else {
        fail('userB GET /api/products/search', JSON.stringify(data).slice(0, 120));
      }
    } catch (e) { fail('userB GET /api/products/search', e.message); }

    // userB GET /api/products/:id → 404
    try {
      const { status } = await req('GET', `/api/products/${productId}`, {
        token: userB.token, expectStatus: 404,
      });
      status === 404
        ? pass('userB GET /api/products/:id → 404')
        : fail('Isolation: userB can fetch userA product', `got ${status}`);
    } catch (e) { fail('userB GET /api/products/:id', e.message); }

    // userB POST /api/products/:id/ask → 404
    try {
      const { status } = await req('POST', `/api/products/${productId}/ask`, {
        token: userB.token, body: { question: 'hijack attempt' }, expectStatus: 404,
      });
      status === 404
        ? pass('userB POST /api/products/:id/ask → 404')
        : fail('Isolation: userB can ask about userA product', `got ${status}`);
    } catch (e) { fail('userB POST ask', e.message); }

    // userB POST /api/products/:id/find-retailers → 403 (different pattern from GET)
    // Documents the 404-vs-403 inconsistency rather than asserting uniformity.
    try {
      const { status } = await req('POST', `/api/products/${productId}/find-retailers`, {
        token: userB.token, body: {}, expectStatus: 403,
      });
      status === 403
        ? pass('userB POST /find-retailers → 403 (as designed)')
        : fail('Isolation: userB find-retailers wrong status', `got ${status}, expected 403`);
    } catch (e) { fail('userB POST find-retailers', e.message); }

    // userB PATCH /api/products/:id/notes → 404 (after bug fix)
    // Pre-fix this would silently return 200. The test is a forcing function.
    try {
      const { status } = await req('PATCH', `/api/products/${productId}/notes`, {
        token: userB.token, body: { notes: 'HIJACKED' }, expectStatus: 404,
      });
      status === 404
        ? pass('userB PATCH notes → 404 (silent-success bug fixed)')
        : fail('Isolation: userB PATCH notes wrong status', `got ${status}, expected 404 — silent-success bug may be back`);
    } catch (e) { fail('userB PATCH notes', e.message); }

    // Read-after-write cross-check: userA re-fetches, notes must be unchanged
    try {
      const { data, ok } = await req('GET', `/api/products/${productId}`, { token: userA.token });
      if (ok && data.notes !== 'HIJACKED') {
        pass('Isolation cross-check: userA notes not corrupted by userB');
      } else if (ok) {
        fail('Isolation: userB hijacked userA notes', `notes="${data.notes}"`);
      }
    } catch (e) { fail('Isolation cross-check', e.message); }
  }

  // ── 6. Boards ──────────────────────────────────────────────────────────────
  section('Boards');

  // GET /api/boards (empty)
  try {
    const { data, ok } = await req('GET', '/api/boards', { token: userA.token });
    ok && Array.isArray(data.boards)
      ? pass('GET /api/boards', `${data.boards.length} board(s)`)
      : fail('GET /api/boards', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/boards', e.message); }

  // POST /api/boards
  try {
    const { data, ok, status } = await req('POST', '/api/boards', {
      token: userA.token,
      body: { name: 'Test Board 🧪', emoji: '🧪', description: 'Automated test board' },
      expectStatus: 201,
    });
    if (ok && data.id) {
      boardId = data.id;
      pass('POST /api/boards → 201', `"${data.name}" id=${boardId.slice(0, 8)}…`);
    } else {
      fail('POST /api/boards', `status=${status} — ${JSON.stringify(data).slice(0, 120)}`);
    }
  } catch (e) { fail('POST /api/boards', e.message); }

  if (boardId) {
    // GET /api/boards/:id — read-after-write for create
    try {
      const { data, ok } = await req('GET', `/api/boards/${boardId}`, { token: userA.token });
      ok && data.board?.id === boardId
        ? pass('GET /api/boards/:id — read-after-write for create')
        : fail('GET /api/boards/:id', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('GET /api/boards/:id', e.message); }

    // PATCH /api/boards/:id (rename) + read-after-write
    const NEW_NAME = 'Test Board (renamed)';
    try {
      const { data, ok } = await req('PATCH', `/api/boards/${boardId}`, {
        token: userA.token, body: { name: NEW_NAME },
      });
      if (!ok) {
        fail('PATCH board rename', JSON.stringify(data).slice(0, 120));
      } else {
        pass('PATCH /api/boards/:id (rename)');
        const { data: after } = await req('GET', `/api/boards/${boardId}`, { token: userA.token });
        if (after.board?.name === NEW_NAME) {
          pass('Read-after-write: board rename persisted');
        } else {
          fail('Read-after-write: board name not updated', `got="${after.board?.name}"`);
        }
      }
    } catch (e) { fail('PATCH board rename', e.message); }

    if (productId) {
      // POST /api/boards/:id/products (returns 200)
      try {
        const { ok, status } = await req('POST', `/api/boards/${boardId}/products`, {
          token: userA.token, body: { productId }, expectStatus: 200,
        });
        ok ? pass('POST /api/boards/:id/products (add)') : fail('Add product to board', `status=${status}`);
      } catch (e) { fail('Add product to board', e.message); }

      // Verify product appears in board (read-after-write)
      try {
        const { data, ok } = await req('GET', `/api/boards/${boardId}`, { token: userA.token });
        const has = data.products?.some(p => p.id === productId);
        ok && has
          ? pass('Read-after-write: board contains added product')
          : fail('Board product presence', `products=${JSON.stringify(data.products?.map(p => p.id))}`);
      } catch (e) { fail('Board product presence', e.message); }

      // DELETE /api/boards/:id/products/:productId + read-after-write
      try {
        const { ok, status } = await req('DELETE', `/api/boards/${boardId}/products/${productId}`, {
          token: userA.token, expectStatus: 200,
        });
        if (!ok) {
          fail('Remove from board', `status=${status}`);
        } else {
          pass('DELETE /api/boards/:id/products/:productId (remove)');
          const { data: after } = await req('GET', `/api/boards/${boardId}`, { token: userA.token });
          if (!after.products?.some(p => p.id === productId)) {
            pass('Read-after-write: product removed from board');
          } else {
            fail('Read-after-write: product still in board after remove');
          }
        }
      } catch (e) { fail('Remove from board', e.message); }
    } else {
      skip('Board product add/remove', 'no productId');
    }

    // DELETE /api/boards/:id + read-after-write
    try {
      const { ok, status } = await req('DELETE', `/api/boards/${boardId}`, {
        token: userA.token, expectStatus: 200,
      });
      if (!ok) {
        fail('DELETE board', `status=${status}`);
      } else {
        pass('DELETE /api/boards/:id');
        const { status: afterStatus } = await req('GET', `/api/boards/${boardId}`, {
          token: userA.token, expectStatus: 404,
        });
        afterStatus === 404
          ? pass('Read-after-write: deleted board returns 404')
          : fail('Read-after-write: deleted board still accessible', `status=${afterStatus}`);
      }
    } catch (e) { fail('DELETE /api/boards/:id', e.message); }
  }

  // ── 7. Search ──────────────────────────────────────────────────────────────
  section('Search');

  try {
    const { data, ok } = await req('GET', '/api/search?q=chair', { token: userA.token });
    ok
      ? pass('GET /api/search?q=chair', `${data.products?.length ?? 0} product(s)`)
      : fail('GET /api/search', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/search', e.message); }

  try {
    const { data, ok } = await req('GET', '/api/search/categories', { token: userA.token });
    ok && Array.isArray(data.categories)
      ? pass('GET /api/search/categories', `${data.categories.length} categor(y/ies)`)
      : fail('GET /api/search/categories', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/search/categories', e.message); }

  // ── 8. Notifications ──────────────────────────────────────────────────────
  section('Notifications');

  try {
    const { data, ok } = await req('GET', '/api/notifications', { token: userA.token });
    ok && Array.isArray(data.notifications)
      ? pass('GET /api/notifications', `${data.notifications.length} notification(s)`)
      : fail('GET /api/notifications', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/notifications', e.message); }

  try {
    const { ok } = await req('PATCH', '/api/notifications/read-all', { token: userA.token, body: {} });
    ok ? pass('PATCH /api/notifications/read-all') : fail('PATCH notifications read-all', 'failed');
  } catch (e) { fail('PATCH notifications read-all', e.message); }

  // ── 9. Subscriptions ──────────────────────────────────────────────────────
  section('Subscriptions');

  try {
    const { data, ok } = await req('GET', '/api/subscriptions/status', { token: userA.token });
    ok
      ? pass('GET /api/subscriptions/status', `status="${data.status ?? data.subscription_status ?? '—'}"`)
      : fail('GET /api/subscriptions/status', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/subscriptions/status', e.message); }

  // ── 10. Social URL routing (no hard block) ─────────────────────────────────
  section('Social URL handling');

  const INSTAGRAM_URL = 'https://www.instagram.com/p/C0test123456/';
  try {
    const { data, ok, status } = await req('POST', '/api/imports/link', {
      token: userA.token, body: { url: INSTAGRAM_URL }, expectStatus: 202,
    });
    ok && data.importId
      ? pass('Instagram URL accepted (202) — not blocked at routing', `importId=${data.importId.slice(0, 8)}…`)
      : fail('Instagram URL routing', `status=${status}, body=${JSON.stringify(data).slice(0, 120)}`);
  } catch (e) { fail('Instagram URL routing', e.message); }

  const PINTEREST_URL = 'https://www.pinterest.co.uk/pin/123456789012345678/';
  try {
    const { data, ok, status } = await req('POST', '/api/imports/link', {
      token: userA.token, body: { url: PINTEREST_URL }, expectStatus: 202,
    });
    ok && data.importId
      ? pass('Pinterest URL accepted (202) — not blocked at routing')
      : fail('Pinterest URL routing', `status=${status}, body=${JSON.stringify(data).slice(0, 120)}`);
  } catch (e) { fail('Pinterest URL routing', e.message); }

  // ── 11. URL stress — representative subset of real-world URL types ────────
  // Validates the full 4-tier import pipeline (platform APIs, scrape+AI,
  // URL inference, screenshot fallback) by importing one URL from each
  // major category and checking the result completes within 90s.
  // Full 25-URL stress test lives in urlImportTest.js for ad-hoc runs.
  section('URL stress — real-world URLs');

  const STRESS_URLS = [
    { label: 'YouTube',          url: 'https://youtu.be/ZBWMyLvkFhA' },
    { label: 'Apple Podcasts',   url: 'https://podcasts.apple.com/us/podcast/the-rest-is-history/id1537788786' },
    { label: 'IMDb (inference)', url: 'https://www.imdb.com/title/tt0111161/' },
    { label: 'IKEA (inference)', url: 'https://www.ikea.com/gb/en/p/kallax-shelving-unit-white-20275806/' },
    { label: 'BBC Good Food',    url: 'https://www.bbcgoodfood.com/recipes/best-spaghetti-bolognese-recipe' },
    { label: 'Squarespace site', url: 'https://www.joelmeyerowitz.com/publications-/where-i-find-myself-1' },
  ];

  for (const { label, url } of STRESS_URLS) {
    try {
      const post = await req('POST', '/api/imports/link', {
        token: userA.token, body: { url }, expectStatus: 202,
      });
      if (!post.ok || !post.data.importId) {
        fail(`URL stress — ${label}`, `POST status=${post.status}`);
        continue;
      }
      const result = await pollImport(post.data.importId, userA.token, 90_000);
      if (result.status === 'completed' && result.productId) {
        pass(`URL stress — ${label} completed`, `productId=${result.productId.slice(0, 8)}…`);
      } else if (result.status === 'awaiting_confirmation') {
        // Single-suggestion auto-accept should mean we never see this for these URLs.
        // If we do, it's a regression in the auto-accept logic.
        fail(`URL stress — ${label}`, 'unexpected awaiting_confirmation (auto-accept regression)');
      } else {
        fail(`URL stress — ${label}`, `status=${result.status}${result.error ? ` — ${result.error}` : ''}`);
      }
    } catch (e) {
      fail(`URL stress — ${label}`, e.message);
    }
  }

  // ── 12. Cleanup ────────────────────────────────────────────────────────────
  section('Cleanup');

  if (productId) {
    try {
      const { ok } = await req('DELETE', `/api/products/${productId}`, { token: userA.token, expectStatus: 200 });
      if (!ok) {
        fail('Cleanup: delete product', 'failed');
      } else {
        pass('DELETE /api/products/:id (test product removed)');
        // Read-after-write: GET should now 404
        const { status } = await req('GET', `/api/products/${productId}`, {
          token: userA.token, expectStatus: 404,
        });
        status === 404
          ? pass('Read-after-write: deleted product returns 404')
          : fail('Read-after-write: deleted product still accessible', `status=${status}`);
      }
    } catch (e) { fail('Cleanup: delete product', e.message); }
  } else {
    skip('Delete test product', 'no productId');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run wrapper — try/finally guarantees cleanup and summary output even on
// unhandled errors.
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  try {
    await main();
  } catch (err) {
    emit(`\n${c.red}${c.bold}  Test runner error: ${err.message}${c.reset}`);
    emit(`${c.dim}${err.stack}${c.reset}`);
    results.push({
      status: 'fail',
      name: 'Test runner crash',
      reason: err.message,
      section: 'General',
      severity: 'critical',
    });
    failed++;
  } finally {
    // Post-run cleanup — purge this run's test users. Non-fatal.
    emit(`\n${c.dim}Post-run cleanup…${c.reset}`);
    try {
      await cleanupTestUsers(0, 'post-run');
    } catch (e) {
      emit(`  ${c.yellow}Post-run cleanup warning: ${e.message}${c.reset}`);
    }

    printSummary();
    printPMSummary();

    // Write log file
    try {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(LOG_FILE, logLines.join('\n') + '\n');
      emit(`\n${c.dim}  Log saved → ${LOG_FILE}${c.reset}`);
    } catch { /* not fatal */ }

    if (JSON_MODE) {
      process.stdout.write('\n' + JSON.stringify({ passed, failed, skipped, results }, null, 2) + '\n');
    }

    process.exit(failed > 0 ? 1 : 0);
  }
}

function printSummary() {
  const total = passed + failed + skipped;
  const bar   = '═'.repeat(44);
  emit(`\n${c.bold}╔${bar}╗${c.reset}`);
  emit(`${c.bold}║  Test Results                              ║${c.reset}`);
  emit(`${c.bold}╠${bar}╣${c.reset}`);
  emit(`${c.bold}║${c.reset}  ${c.green}✓ Passed : ${String(passed).padEnd(5)}${c.reset}  ${c.dim}(${Math.round(passed / Math.max(total, 1) * 100)}%)${c.reset}${' '.repeat(22)}${c.bold}║${c.reset}`);
  if (failed > 0)
    emit(`${c.bold}║${c.reset}  ${c.red}✗ Failed : ${String(failed).padEnd(5)}${c.reset}${' '.repeat(29)}${c.bold}║${c.reset}`);
  if (skipped > 0)
    emit(`${c.bold}║${c.reset}  ${c.yellow}⟳ Skipped: ${String(skipped).padEnd(5)}${c.reset}${' '.repeat(29)}${c.bold}║${c.reset}`);
  emit(`${c.bold}║${c.reset}  Total   : ${total}${' '.repeat(34)}${c.bold}║${c.reset}`);
  emit(`${c.bold}╚${bar}╝${c.reset}`);

  const failures = results.filter(r => r.status === 'fail');
  if (failures.length > 0) {
    emit(`\n${c.red}${c.bold}  Failed tests:${c.reset}`);
    failures.forEach(({ name, reason, section }) => {
      emit(`  ${c.red}✗${c.reset} [${section}] ${name}`);
      if (reason) emit(`    ${c.dim}${reason}${c.reset}`);
    });
  } else {
    emit(`\n  ${c.green}${c.bold}All tests passed! ✓${c.reset}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PM Summary — plain-language status block for non-technical readers.
// Bracketed by stable markers so the scheduled task can grep it reliably.
// ─────────────────────────────────────────────────────────────────────────────
function printPMSummary() {
  const total = passed + failed + skipped;
  const failures = results.filter(r => r.status === 'fail');
  const failedSections = new Set(failures.map(f => f.section));
  const skipCount = results.filter(r => r.status === 'skip').length;

  // Plain-language phrases keyed by section. Ordered worst-first.
  const SECTION_MESSAGES = {
    'Two-user isolation':      { sev: 'critical',  msg: '🚨 URGENT: Users can see or modify each other\'s private products. This is a privacy bug — do not deploy.' },
    'Auth':                    { sev: 'critical',  msg: '🚨 Login and sign-up are down. No one can get into Stash right now.' },
    'Health':                  { sev: 'critical',  msg: '🚨 The backend itself is unreachable or unhealthy.' },
    'Import — link':           { sev: 'degraded',  msg: '⚠️ Saving products from links is broken. Users who share a link with Stash will see an error.' },
    'Fixtures — alt paths':    { sev: 'degraded',  msg: '⚠️ Some product pages (with unusual formatting) aren\'t being parsed correctly during import.' },
    'Products — post-import':  { sev: 'degraded',  msg: '⚠️ Something\'s wrong with saved products — viewing details, notes, the AI "Ask" feature, or price tracking may be broken.' },
    'Boards':                  { sev: 'degraded',  msg: '⚠️ Boards are broken — users can\'t organize their saved items.' },
    'Search':                  { sev: 'degraded',  msg: '⚠️ Search isn\'t returning results properly.' },
    'Products — empty state':  { sev: 'degraded',  msg: '⚠️ Fresh accounts aren\'t showing the right initial state.' },
    'Subscriptions':           { sev: 'minor',     msg: 'Minor: subscription status checks aren\'t working — may affect billing info display.' },
    'Notifications':           { sev: 'minor',     msg: 'Minor: notifications aren\'t updating properly.' },
    'Social URL handling':     { sev: 'minor',     msg: 'Minor: Instagram/Pinterest link handling has a routing issue.' },
    'Cleanup':                 { sev: 'minor',     msg: 'Minor: test cleanup had a hiccup (internal — not user-facing).' },
    'General':                 { sev: 'critical',  msg: '🚨 The test runner itself crashed unexpectedly.' },
  };

  emit('');
  emit('===== PM SUMMARY START =====');

  if (failed === 0) {
    emit(`✅ All ${total} checks passing. Stash is working correctly.`);
    emit(`   Tests run: ${total}  •  Passed: ${passed}${skipped > 0 ? `  •  Skipped: ${skipped}` : ''}`);
    emit('===== PM SUMMARY END =====');
    return;
  }

  // Group failures by severity
  const bySeverity = { critical: [], degraded: [], minor: [] };
  for (const sectionName of failedSections) {
    const entry = SECTION_MESSAGES[sectionName] || { sev: 'degraded', msg: `⚠️ Something is broken in the "${sectionName}" area.` };
    const count = failures.filter(f => f.section === sectionName).length;
    bySeverity[entry.sev].push({ section: sectionName, msg: entry.msg, count });
  }

  // Headline: lead with worst severity
  let headline;
  if (bySeverity.critical.length > 0) {
    headline = `🚨 ${failed} check${failed > 1 ? 's' : ''} failing. Critical issue${bySeverity.critical.length > 1 ? 's' : ''} detected — needs urgent attention.`;
  } else if (bySeverity.degraded.length > 0) {
    headline = `⚠️ ${failed} check${failed > 1 ? 's' : ''} failing. Stash is degraded but still running.`;
  } else {
    headline = `${failed} minor check${failed > 1 ? 's' : ''} failing. Non-urgent issue${failed > 1 ? 's' : ''} detected.`;
  }
  emit(headline);
  emit('');

  // Bullet points, critical first
  const severityOrder = ['critical', 'degraded', 'minor'];
  for (const sev of severityOrder) {
    for (const item of bySeverity[sev]) {
      emit(`• ${item.msg}`);
    }
  }

  // Skip-cascade note
  const skipsFromCrash = results.filter(r => r.status === 'skip');
  if (skipsFromCrash.length >= 3) {
    emit('');
    emit(`  (${skipsFromCrash.length} downstream checks couldn't run because of upstream failures above.)`);
  }

  // Claude action line
  emit('');
  emit('Claude is investigating the root cause and will propose a fix when you\'re next online.');
  emit(`   Technical log: ${LOG_FILE}`);

  emit('===== PM SUMMARY END =====');
}

run().catch(err => {
  console.error(`\n${C.red}Test runner crashed hard: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
