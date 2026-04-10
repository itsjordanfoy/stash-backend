#!/usr/bin/env node
/**
 * ┌──────────────────────────────────────────────────────────┐
 * │  Stash — Screenshot Import Stress Test                   │
 * │                                                          │
 * │  Imports every image file in backend/test-screenshots/   │
 * │  via the /api/imports/screenshot endpoint and reports    │
 * │  exactly which ones succeed/fail with what data.         │
 * │                                                          │
 * │  Usage:                                                  │
 * │    1. Drop .png/.jpg/.jpeg files in backend/test-        │
 * │       screenshots/ (any subfolder structure works).      │
 * │    2. Optionally name them descriptively:                │
 * │       restaurant-dishoom.png  →  reported as "restaurant │
 * │       dishoom"                                           │
 * │    3. TEST_BASE_URL=https://...railway.app node          │
 * │       backend/src/scripts/screenshotImportTest.js        │
 * └──────────────────────────────────────────────────────────┘
 */

require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env'),
  override: true,
});

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const SCREENSHOTS_DIR = path.resolve(__dirname, '../../test-screenshots');
const POLL_TIMEOUT_MS = 120_000;
const IMPORT_DELAY_MS = 500;

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

// ── Discover screenshots ─────────────────────────────────────────────────────
function findScreenshots(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...findScreenshots(full));
    } else if (/\.(png|jpe?g|webp)$/i.test(e.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function labelFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath))
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

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

async function uploadScreenshot(filePath, token) {
  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const mimeType = /\.png$/i.test(filename) ? 'image/png'
                  : /\.jpe?g$/i.test(filename) ? 'image/jpeg'
                  : /\.webp$/i.test(filename) ? 'image/webp'
                  : 'application/octet-stream';

  // Build multipart/form-data manually so we don't need extra deps
  const boundary = '----stash-screenshot-' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="screenshot"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fileBuffer, tail]);

  const res = await fetch(`${BASE_URL}/api/imports/screenshot`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });

  const text = await res.text();
  let data;
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`\n${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`${c.bold}${c.cyan}  Stash — Screenshot Import Stress Test${c.reset}`);
  log(`${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);

  const screenshots = findScreenshots(SCREENSHOTS_DIR);
  if (screenshots.length === 0) {
    log(`${c.yellow}No screenshots found in ${SCREENSHOTS_DIR}${c.reset}`);
    log(`${c.dim}Drop .png/.jpg files in that directory to run the test.${c.reset}\n`);
    process.exit(0);
  }

  log(`${c.dim}  Base URL:    ${BASE_URL}${c.reset}`);
  log(`${c.dim}  Screenshots: ${screenshots.length}${c.reset}`);
  log(`${c.dim}  Started:     ${new Date().toISOString()}${c.reset}\n`);

  // Register a fresh test user
  const runId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const user = {
    email: `stash_test_${runId}_screenshot@test.internal`,
    password: 'TestPass!9x',
    token: null,
  };

  const reg = await jsonReq('POST', '/api/auth/register', {
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

  for (let i = 0; i < screenshots.length; i++) {
    const filePath = screenshots[i];
    const label = labelFromPath(filePath);
    const fileSize = (fs.statSync(filePath).size / 1024).toFixed(0);
    process.stdout.write(`${c.dim}${(i + 1).toString().padStart(2)}/${screenshots.length}  ${label.padEnd(36).slice(0, 36)} ${fileSize}KB${c.reset}\n`);

    const start = Date.now();

    const post = await uploadScreenshot(filePath, user.token);
    if (post.status !== 202 || !post.data.importId) {
      const err = typeof post.data === 'object' ? post.data.error || JSON.stringify(post.data).slice(0, 150) : String(post.data).slice(0, 150);
      log(`     ${c.red}✗ POST failed (status=${post.status}): ${err}${c.reset}\n`);
      results.push({ filePath, label, success: false, reason: `POST ${post.status}: ${err}` });
      await sleep(IMPORT_DELAY_MS);
      continue;
    }

    const result = await pollImport(post.data.importId, user.token);
    const durationMs = Date.now() - start;

    if (result.status === 'completed') {
      const p = result.product || {};
      const details = [
        p.name ? `name="${p.name.slice(0, 40)}"` : null,
        p.item_type ? `type=${p.item_type}` : null,
        p.image_url ? 'image=✓' : 'image=✗',
      ].filter(Boolean).join('  ');
      log(`     ${c.green}✓${c.reset} ${c.dim}${(durationMs / 1000).toFixed(1)}s  ${details}${c.reset}\n`);
      results.push({ filePath, label, success: true, product: p, durationMs });
    } else if (result.status === 'awaiting_confirmation') {
      log(`     ${c.yellow}⟳ awaiting_confirmation${c.reset}\n`);
      results.push({ filePath, label, success: false, reason: 'awaiting_confirmation', durationMs });
    } else if (result.status === 'failed') {
      log(`     ${c.red}✗ ${result.error || '(no error)'}${c.reset}\n`);
      results.push({ filePath, label, success: false, reason: result.error || 'unknown', durationMs });
    } else if (result.status === 'timeout') {
      log(`     ${c.yellow}⟳ timed out after ${(POLL_TIMEOUT_MS / 1000)}s${c.reset}\n`);
      results.push({ filePath, label, success: false, reason: 'timeout', durationMs });
    }

    await sleep(IMPORT_DELAY_MS);
  }

  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  log(`\n${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`${c.bold}  Summary${c.reset}`);
  log(`${c.bold}${c.cyan}══════════════════════════════════════════════════════════${c.reset}`);
  log(`  ${c.green}Passed: ${passed}${c.reset}  ${c.red}Failed: ${failed}${c.reset}  ${c.dim}Total: ${results.length}${c.reset}`);

  if (failed > 0) {
    log(`\n${c.bold}${c.red}  Failures:${c.reset}`);
    for (const r of results.filter(x => !x.success)) {
      log(`    ${c.red}✗${c.reset} ${c.bold}${r.label}${c.reset}`);
      log(`        ${c.dim}${path.relative(SCREENSHOTS_DIR, r.filePath)}${c.reset}`);
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
