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
    // A real window needs a display. On a Linux server there is none, so the
    // app must run under a virtual one (Xvfb) — deploy/nesstech-workana.service
    // does that with xvfb-run. Fail with a useful message instead of
    // Playwright's generic "Missing X server".
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error(
        'Sem display gráfico ($DISPLAY vazio). No servidor, rode via xvfb-run ' +
          '(ex: xvfb-run -a npm start) ou pelo serviço systemd em deploy/.'
      );
    }
    browserPromise = chromium.launch({
      headless: false,
      args: show ? [] : ['--start-minimized']
    });
    // On a long-running server a crashed/killed Chromium (or a failed launch)
    // must not stay cached forever — drop it so the next call relaunches.
    const launching = browserPromise;
    launching
      .then((browser) => browser.on('disconnected', () => {
        if (browserPromise === launching) browserPromise = null;
      }))
      .catch(() => {
        if (browserPromise === launching) browserPromise = null;
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
    const pending = browserPromise;
    browserPromise = null;
    try {
      const browser = await pending;
      await browser.close();
    } catch {
      // launch had failed or the browser was already gone — nothing to close
    }
  }
}

module.exports = { getBrowser, newContext, jitter, shutdown };
