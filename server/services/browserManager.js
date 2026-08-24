const { chromium } = require('playwright');
const logger = require('./logger');

// Workana sits behind Cloudflare's bot check, which blocks headless Chromium
// outright (confirmed: headless => 0 results, real window => works fine).
// So this launches a REAL, ordinary browser window — no fingerprint spoofing,
// no stealth plugins, nothing that pretends to be something it isn't. The
// only accommodation is --start-minimized, so it doesn't jump in front of you
// or need your mouse. One shared instance is reused across scans and sends.
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    const show = process.env.WORKANA_SHOW_WINDOW === 'true';
    browserPromise = chromium.launch({
      headless: false,
      args: show ? [] : ['--start-minimized']
    });
    logger.info(`Navegador do Workana iniciado (${show ? 'janela visível' : 'minimizado'}).`);
  }
  return browserPromise;
}

async function newContext(opts = {}) {
  const browser = await getBrowser();
  return browser.newContext({ locale: 'pt-BR', ...opts });
}

async function jitter(min = 300, max = 1200) {
  const ms = Math.floor(Math.random() * (max - min)) + min;
  await new Promise((r) => setTimeout(r, ms));
}

async function shutdown() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

module.exports = { getBrowser, newContext, jitter, shutdown };
