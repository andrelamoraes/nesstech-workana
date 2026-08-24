const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../db');
const logger = require('./logger');

const DIAG_DIR = path.join(DATA_DIR, 'diagnostics');

// Cloudflare's interstitial is a page with no login form and no user menu — so
// "the login field isn't there" is NOT proof that we're authenticated. Every
// caller that used to reason that way now goes through classify() instead.
const CHALLENGE_MARKERS = [
  'just a moment',
  'um momento',
  'checking your browser',
  'verificando seu navegador',
  'verify you are human',
  'cf-browser-verification',
  'attention required'
];

const TWOFA_MARKERS = [
  'verification code',
  'codigo de verificacion',
  'codigo de verificacao',
  'two-factor',
  'autenticacao de dois fatores',
  'autenticacion de dos factores'
];

function deaccent(text) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

// Positive signal that a real, authenticated Workana page rendered: the
// header's user menu / logout link only exists for a logged-in visitor.
const LOGGED_IN_SELECTORS = [
  'a[href*="/logout"]',
  'a[href*="/dashboard"]',
  '.user-menu',
  '#user-menu',
  'header .avatar',
  'a[href*="/messages"]'
];

async function anyVisible(page, selectors) {
  for (const sel of selectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) return sel;
  }
  return null;
}

/**
 * Tells apart the four states a Workana page can actually be in, instead of
 * the old two-way guess. Returns one of:
 *   'challenge'   Cloudflare is holding the page — nothing on it is real yet
 *   'twofa'       Workana is asking for a 2FA code, which only you can supply
 *   'anonymous'   real page, not logged in (login form present)
 *   'authenticated'
 */
async function classify(page) {
  const title = ((await page.title().catch(() => '')) || '').toLowerCase();
  const bodyText = deaccent(
    (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).toLowerCase()
  );

  if (CHALLENGE_MARKERS.some((m) => title.includes(m) || bodyText.includes(deaccent(m)))) {
    return 'challenge';
  }

  const hasLoginField = (await page.locator('#email-input').count().catch(() => 0)) > 0;

  if (TWOFA_MARKERS.some((m) => bodyText.includes(deaccent(m))) && !hasLoginField) {
    return 'twofa';
  }

  if (hasLoginField) return 'anonymous';

  const marker = await anyVisible(page, LOGGED_IN_SELECTORS);
  if (marker) return 'authenticated';

  // No login form, no challenge text, but also no proof of a session. Treat as
  // unknown-but-not-authenticated: better a clear error than a silent no-op.
  return 'unknown';
}

// Cloudflare usually clears on its own within a few seconds once a real
// browser has run the check. Wait it out rather than failing immediately.
async function waitOutChallenge(page, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stateNow = await classify(page);
  while (stateNow === 'challenge' && Date.now() < deadline) {
    await page.waitForTimeout(1500);
    stateNow = await classify(page);
  }
  return stateNow;
}

function ensureDiagDir() {
  if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });
}

function slugify(text) {
  return String(text || 'sem-titulo')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
}

/**
 * Freezes everything we'd want when a send goes wrong: screenshot, HTML, final
 * URL, visible text. Without this, debugging a failed automatic send means
 * staring at a browser that already closed.
 */
async function captureDiagnostics(page, label) {
  try {
    ensureDiagDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIAG_DIR, `${stamp}-${slugify(label)}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) fs.writeFileSync(`${base}.html`, html, 'utf8');
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${text}`, 'utf8');
    logger.warn(`Diagnóstico salvo em data/diagnostics/${path.basename(base)}.{png,html,txt}`);
    return base;
  } catch (err) {
    logger.error(`Não consegui salvar o diagnóstico: ${err.message}`);
    return null;
  }
}

module.exports = { classify, waitOutChallenge, captureDiagnostics, DIAG_DIR };
