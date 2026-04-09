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
 * └─────────────────────────────────────────────────────────┘
 */

require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env'),
  override: true,
});

const fs   = require('fs');
const path = require('path');

const BASE_URL   = process.env.TEST_BASE_URL || 'http://localhost:3000';
const JSON_MODE  = process.argv.includes('--json');
const LOG_DIR    = path.resolve(__dirname, '../../logs');
const TS         = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE   = path.join(LOG_DIR, `test-${TS}.log`);

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

function emit(line) {
  console.log(line);
  logLines.push(line.replace(/\x1b\[[0-9;]*m/g, '')); // strip ANSI for log file
}

function section(name) {
  emit(`\n${c.bold}${c.cyan}▸ ${name}${c.reset}`);
}

function pass(name, detail = '') {
  passed++;
  results.push({ status: 'pass', name });
  emit(`  ${c.green}✓${c.reset} ${name}${detail ? `  ${c.dim}${detail}${c.reset}` : ''}`);
}

function fail(name, reason = '') {
  failed++;
  results.push({ status: 'fail', name, reason });
  emit(`  ${c.red}✗${c.reset} ${name}`);
  if (reason) emit(`    ${c.dim}↳ ${reason}${c.reset}`);
}

function skip(name, reason = '') {
  skipped++;
  results.push({ status: 'skip', name, reason });
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

// ── Unique test identity ──────────────────────────────────────────────────────
const RUN_ID   = Date.now();
const EMAIL    = `stash_test_${RUN_ID}@test.internal`;
const PASSWORD = 'TestPass!9x';

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  emit(`\n${c.bold}${c.white}╔═══════════════════════════════════════════╗${c.reset}`);
  emit(`${c.bold}${c.white}║  Stash Backend Test Suite — ${new Date().toUTCString().slice(0,16)}  ║${c.reset}`);
  emit(`${c.bold}${c.white}╚═══════════════════════════════════════════╝${c.reset}`);
  emit(`${c.dim}  Target : ${BASE_URL}${c.reset}`);
  emit(`${c.dim}  User   : ${EMAIL}${c.reset}`);

  let token     = null;
  let productId = null;
  let boardId   = null;

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

  // Register fresh test user
  try {
    const { data, ok, status } = await req('POST', '/api/auth/register', {
      body: { email: EMAIL, password: PASSWORD, displayName: 'Test Runner' },
      expectStatus: 201,
    });
    if (ok && data.token) {
      token = data.token;
      pass('POST /api/auth/register → 201', `userId=${data.user?.id?.slice(0, 8)}…`);
    } else {
      fail('POST /api/auth/register', `status=${status} — ${JSON.stringify(data).slice(0, 120)}`);
    }
  } catch (e) { fail('POST /api/auth/register', e.message); }

  if (!token) {
    emit(`\n${c.red}${c.bold}  Cannot continue without auth token.${c.reset}\n`);
    printSummary();
    process.exit(1);
  }

  // Login
  try {
    const { data, ok, status } = await req('POST', '/api/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
    });
    ok && data.token
      ? pass('POST /api/auth/login → 200')
      : fail('POST /api/auth/login', `status=${status}`);
  } catch (e) { fail('POST /api/auth/login', e.message); }

  // Wrong password
  try {
    const { status } = await req('POST', '/api/auth/login', {
      body: { email: EMAIL, password: 'WrongPassword1' },
      expectStatus: 401,
    });
    status === 401 ? pass('Wrong password → 401') : fail('Wrong password rejection', `got ${status}`);
  } catch (e) { fail('Wrong password rejection', e.message); }

  // No token → 401
  try {
    const { status } = await req('GET', '/api/users/me', { expectStatus: 401 });
    status === 401 ? pass('No auth token → 401') : fail('No auth token rejection', `got ${status}`);
  } catch (e) { fail('No auth token rejection', e.message); }

  // GET /api/users/me
  try {
    const { data, ok } = await req('GET', '/api/users/me', { token });
    ok && data.email === EMAIL
      ? pass('GET /api/users/me')
      : fail('GET /api/users/me', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/users/me', e.message); }

  // GET /api/users/me/stats
  try {
    const { data, ok } = await req('GET', '/api/users/me/stats', { token });
    ok ? pass('GET /api/users/me/stats') : fail('GET /api/users/me/stats', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/users/me/stats', e.message); }

  // ── 3. Products — empty state ──────────────────────────────────────────────
  section('Products — empty state');

  try {
    const { data, ok } = await req('GET', '/api/products/recent?limit=20', { token });
    ok && Array.isArray(data.products) && data.products.length === 0
      ? pass('GET /api/products/recent → empty array')
      : fail('GET /api/products/recent (empty)', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/products/recent (empty)', e.message); }

  try {
    const { data, ok } = await req('GET', '/api/products/search?q=chair', { token });
    ok && Array.isArray(data.products)
      ? pass('GET /api/products/search (empty)', `${data.products.length} results`)
      : fail('GET /api/products/search (empty)', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/products/search (empty)', e.message); }

  // 404 for unknown product
  try {
    const { status } = await req('GET', '/api/products/00000000-0000-0000-0000-000000000000', {
      token, expectStatus: 404,
    });
    status === 404 ? pass('GET /api/products/:id unknown → 404') : fail('Unknown product 404', `got ${status}`);
  } catch (e) { fail('Unknown product 404', e.message); }

  // ── 4. Imports ─────────────────────────────────────────────────────────────
  section('Import — link');

  // Missing URL body
  try {
    const { status } = await req('POST', '/api/imports/link', { token, body: {}, expectStatus: 400 });
    status === 400 ? pass('Missing URL → 400') : fail('Missing URL rejection', `got ${status}`);
  } catch (e) { fail('Missing URL rejection', e.message); }

  // Invalid URL
  try {
    const { status } = await req('POST', '/api/imports/link', {
      token, body: { url: 'not-a-real-url' }, expectStatus: 400,
    });
    status === 400 ? pass('Invalid URL format → 400') : fail('Invalid URL rejection', `got ${status}`);
  } catch (e) { fail('Invalid URL rejection', e.message); }

  // Real product import (IKEA — stable, OG-rich, fast)
  const IMPORT_URL = 'https://www.ikea.com/gb/en/p/kallax-shelf-unit-white-00275862/';
  let importId = null;
  try {
    const { data, ok, status } = await req('POST', '/api/imports/link', {
      token,
      body: { url: IMPORT_URL },
      expectStatus: 202,
    });
    if (ok && data.importId) {
      importId = data.importId;
      pass(`POST /api/imports/link → 202`, `importId=${importId.slice(0, 8)}…`);
    } else {
      fail('POST /api/imports/link', `status=${status} — ${JSON.stringify(data).slice(0, 120)}`);
    }
  } catch (e) { fail('POST /api/imports/link', e.message); }

  // GET /api/imports/:id — immediate status check (should be processing)
  if (importId) {
    try {
      const { data, ok } = await req('GET', `/api/imports/${importId}`, { token });
      ok && ['processing', 'pending', 'completed'].includes(data.status)
        ? pass(`GET /api/imports/:id → status="${data.status}"`)
        : fail('GET /api/imports/:id', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('GET /api/imports/:id', e.message); }
  }

  // Poll until completed / awaiting confirmation
  if (importId) {
    emit(`\n  ${c.dim}  Polling import (up to 90s)…${c.reset}`);
    try {
      const result = await pollImport(importId, token);
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
          // Auto-confirm first suggestion (simulates user picking a match)
          const suggestion = result.suggestions?.[0];
          if (suggestion) {
            const { data, ok } = await req('POST', `/api/imports/${importId}/confirm`, {
              token,
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

  // ── 5. Products — post-import ──────────────────────────────────────────────
  section('Products — post-import');

  if (!productId) {
    skip('All post-import product tests', 'import did not produce a productId');
  } else {
    // Recent list includes new product
    try {
      const { data, ok } = await req('GET', '/api/products/recent?limit=20', { token });
      if (ok && data.products?.some(p => p.id === productId)) {
        pass('GET /api/products/recent — new product present');
      } else if (ok) {
        fail('GET /api/products/recent', 'New product not in recent list (cache issue?)');
      } else {
        fail('GET /api/products/recent', JSON.stringify(data).slice(0, 120));
      }
    } catch (e) { fail('GET /api/products/recent (post-import)', e.message); }

    // GET /api/products/:id
    let productName = '';
    try {
      const { data, ok } = await req('GET', `/api/products/${productId}`, { token });
      if (ok && data.id === productId) {
        productName = data.name ?? '';
        pass(`GET /api/products/:id`, `"${productName.slice(0, 40)}"`);
        // Validate key fields
        if (!data.name) fail('Product has no name');
        else pass('Product.name present');
        if (data.retailers !== undefined) pass(`Product.retailers present (${data.retailers.length})`);
        else fail('Product.retailers missing');
      } else {
        fail('GET /api/products/:id', JSON.stringify(data).slice(0, 120));
      }
    } catch (e) { fail('GET /api/products/:id', e.message); }

    // GET /api/products/search — should surface the new product
    try {
      const q = encodeURIComponent(productName.split(' ')[0] || 'KALLAX');
      const { data, ok } = await req('GET', `/api/products/search?q=${q}`, { token });
      ok && Array.isArray(data.products)
        ? pass(`GET /api/products/search?q=${q}`, `${data.products.length} result(s)`)
        : fail('GET /api/products/search', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('GET /api/products/search', e.message); }

    // PATCH notes
    try {
      const { ok, status } = await req('PATCH', `/api/products/${productId}/notes`, {
        token, body: { notes: 'Automated test note — safe to delete.' },
      });
      ok ? pass('PATCH /api/products/:id/notes') : fail('PATCH notes', `status=${status}`);
    } catch (e) { fail('PATCH notes', e.message); }

    // Clear notes
    try {
      const { ok } = await req('PATCH', `/api/products/${productId}/notes`, {
        token, body: { notes: '' },
      });
      ok ? pass('PATCH /api/products/:id/notes (clear)') : fail('PATCH notes (clear)', 'failed');
    } catch (e) { fail('PATCH notes (clear)', e.message); }

    // POST /api/products/:id/auto-board
    try {
      const { data, ok } = await req('POST', `/api/products/${productId}/auto-board`, {
        token, body: {},
      });
      ok
        ? pass('POST /api/products/:id/auto-board', `suggestion="${data.board?.name ?? 'none'}"`)
        : fail('POST auto-board', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('POST auto-board', e.message); }

    // POST /api/products/:id/ask — SSE streaming
    try {
      const res = await fetch(`${BASE_URL}/api/products/${productId}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ question: '💡 What is this product used for?' }),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.status === 200 && res.headers.get('content-type')?.includes('text/event-stream')) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';
        let tokenCount = 0;
        let done = false;

        while (!done && tokenCount < 5) {
          const { value, done: d } = await reader.read();
          done = d;
          if (value) {
            raw += decoder.decode(value, { stream: true });
            tokenCount += (raw.match(/data: \{/g) || []).length;
          }
        }
        reader.cancel();

        const hasDone   = raw.includes('[DONE]') || done;
        const hasTokens = raw.includes('data: {');
        if (hasTokens) {
          pass('POST /api/products/:id/ask — SSE streaming', `≥${tokenCount} token(s) received`);
        } else {
          fail('POST /api/products/:id/ask', `No token data in SSE stream. raw=${raw.slice(0, 200)}`);
        }
      } else {
        const text = await res.text().catch(() => '');
        fail('POST /api/products/:id/ask', `status=${res.status}, content-type=${res.headers.get('content-type')}, body=${text.slice(0, 120)}`);
      }
    } catch (e) { fail('POST /api/products/:id/ask', e.message); }

    // POST /api/products/:id/ask — missing question → 400
    try {
      const { status } = await req('POST', `/api/products/${productId}/ask`, {
        token, body: {}, expectStatus: 400,
      });
      status === 400 ? pass('POST ask missing question → 400') : fail('Ask missing question', `got ${status}`);
    } catch (e) { fail('Ask missing question', e.message); }

    // GET /api/prices/:id/history
    try {
      const { data, ok } = await req('GET', `/api/prices/${productId}/history`, { token });
      ok
        ? pass('GET /api/prices/:id/history', `${data.history?.length ?? 0} data point(s)`)
        : fail('GET /api/prices/:id/history', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('GET /api/prices/:id/history', e.message); }

    // Enable / disable price tracking
    try {
      const { ok: trackOk } = await req('POST', `/api/prices/${productId}/track`, { token, body: {} });
      trackOk ? pass('POST /api/prices/:id/track (enable)') : fail('POST price track enable', 'failed');

      const { ok: untrackOk } = await req('DELETE', `/api/prices/${productId}/track`, { token, expectStatus: 200 });
      untrackOk ? pass('DELETE /api/prices/:id/track (disable)') : fail('DELETE price track disable', 'failed');
    } catch (e) { fail('Price tracking', e.message); }
  }

  // ── 6. Boards ──────────────────────────────────────────────────────────────
  section('Boards');

  // GET /api/boards (empty)
  try {
    const { data, ok } = await req('GET', '/api/boards', { token });
    ok && Array.isArray(data.boards)
      ? pass('GET /api/boards', `${data.boards.length} board(s)`)
      : fail('GET /api/boards', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/boards', e.message); }

  // POST /api/boards
  try {
    const { data, ok, status } = await req('POST', '/api/boards', {
      token,
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
    // GET /api/boards/:id
    try {
      const { data, ok } = await req('GET', `/api/boards/${boardId}`, { token });
      ok && data.board?.id === boardId
        ? pass('GET /api/boards/:id')
        : fail('GET /api/boards/:id', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('GET /api/boards/:id', e.message); }

    // PATCH /api/boards/:id (rename)
    try {
      const { data, ok } = await req('PATCH', `/api/boards/${boardId}`, {
        token, body: { name: 'Test Board (renamed)' },
      });
      ok ? pass('PATCH /api/boards/:id (rename)') : fail('PATCH board rename', JSON.stringify(data).slice(0, 120));
    } catch (e) { fail('PATCH board rename', e.message); }

    if (productId) {
      // POST /api/boards/:id/products (returns 200)
      try {
        const { ok, status } = await req('POST', `/api/boards/${boardId}/products`, {
          token, body: { productId }, expectStatus: 200,
        });
        ok ? pass('POST /api/boards/:id/products (add)') : fail('Add product to board', `status=${status}`);
      } catch (e) { fail('Add product to board', e.message); }

      // Verify product appears in board
      try {
        const { data, ok } = await req('GET', `/api/boards/${boardId}`, { token });
        const has = data.products?.some(p => p.id === productId);
        ok && has
          ? pass('Board contains added product ✓')
          : fail('Board product presence', `products=${JSON.stringify(data.products?.map(p => p.id))}`);
      } catch (e) { fail('Board product presence', e.message); }

      // DELETE /api/boards/:id/products/:productId
      try {
        const { ok, status } = await req('DELETE', `/api/boards/${boardId}/products/${productId}`, {
          token, expectStatus: 200,
        });
        ok ? pass('DELETE /api/boards/:id/products/:productId (remove)') : fail('Remove from board', `status=${status}`);
      } catch (e) { fail('Remove from board', e.message); }
    } else {
      skip('Board product add/remove', 'no productId');
    }

    // DELETE /api/boards/:id
    try {
      const { ok, status } = await req('DELETE', `/api/boards/${boardId}`, {
        token, expectStatus: 200,
      });
      ok ? pass('DELETE /api/boards/:id') : fail('DELETE board', `status=${status}`);
    } catch (e) { fail('DELETE /api/boards/:id', e.message); }
  }

  // ── 7. Search ──────────────────────────────────────────────────────────────
  section('Search');

  try {
    const { data, ok } = await req('GET', '/api/search?q=chair', { token });
    ok
      ? pass('GET /api/search?q=chair', `${data.products?.length ?? 0} product(s)`)
      : fail('GET /api/search', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/search', e.message); }

  try {
    const { data, ok } = await req('GET', '/api/search/categories', { token });
    ok && Array.isArray(data.categories)
      ? pass('GET /api/search/categories', `${data.categories.length} categor(y/ies)`)
      : fail('GET /api/search/categories', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/search/categories', e.message); }

  // ── 8. Notifications ──────────────────────────────────────────────────────
  section('Notifications');

  try {
    const { data, ok } = await req('GET', '/api/notifications', { token });
    ok && Array.isArray(data.notifications)
      ? pass('GET /api/notifications', `${data.notifications.length} notification(s)`)
      : fail('GET /api/notifications', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/notifications', e.message); }

  try {
    const { ok } = await req('PATCH', '/api/notifications/read-all', { token, body: {} });
    ok ? pass('PATCH /api/notifications/read-all') : fail('PATCH notifications read-all', 'failed');
  } catch (e) { fail('PATCH notifications read-all', e.message); }

  // ── 9. Subscriptions ──────────────────────────────────────────────────────
  section('Subscriptions');

  try {
    const { data, ok } = await req('GET', '/api/subscriptions/status', { token });
    ok
      ? pass('GET /api/subscriptions/status', `status="${data.status ?? data.subscription_status ?? '—'}"`)
      : fail('GET /api/subscriptions/status', JSON.stringify(data).slice(0, 120));
  } catch (e) { fail('GET /api/subscriptions/status', e.message); }

  // ── 10. Social URL routing (no hard block) ─────────────────────────────────
  section('Social URL handling');

  // Instagram URL — should start import (link pipeline), NOT fail immediately
  const INSTAGRAM_URL = 'https://www.instagram.com/p/C0test123456/';
  try {
    const { data, ok, status } = await req('POST', '/api/imports/link', {
      token, body: { url: INSTAGRAM_URL }, expectStatus: 202,
    });
    // 202 = accepted for processing. Even if AI later can't extract, it shouldn't hard-block here.
    ok && data.importId
      ? pass('Instagram URL accepted (202) — not blocked at routing', `importId=${data.importId.slice(0, 8)}…`)
      : fail('Instagram URL routing', `status=${status}, body=${JSON.stringify(data).slice(0, 120)}`);
  } catch (e) { fail('Instagram URL routing', e.message); }

  // Pinterest URL — same expectation
  const PINTEREST_URL = 'https://www.pinterest.co.uk/pin/123456789012345678/';
  try {
    const { data, ok, status } = await req('POST', '/api/imports/link', {
      token, body: { url: PINTEREST_URL }, expectStatus: 202,
    });
    ok && data.importId
      ? pass('Pinterest URL accepted (202) — not blocked at routing')
      : fail('Pinterest URL routing', `status=${status}, body=${JSON.stringify(data).slice(0, 120)}`);
  } catch (e) { fail('Pinterest URL routing', e.message); }

  // ── 11. Cleanup ────────────────────────────────────────────────────────────
  section('Cleanup');

  if (productId) {
    try {
      const { ok } = await req('DELETE', `/api/products/${productId}`, { token, expectStatus: 200 });
      ok ? pass('DELETE /api/products/:id (test product removed)') : fail('Cleanup: delete product', 'failed');
    } catch (e) { fail('Cleanup: delete product', e.message); }
  } else {
    skip('Delete test product', 'no productId');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  printSummary();

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
    failures.forEach(({ name, reason }) => {
      emit(`  ${c.red}✗${c.reset} ${name}`);
      if (reason) emit(`    ${c.dim}${reason}${c.reset}`);
    });
  } else {
    emit(`\n  ${c.green}${c.bold}All tests passed! ✓${c.reset}`);
  }
}

main().catch(err => {
  console.error(`\n${C.red}Test runner crashed: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
