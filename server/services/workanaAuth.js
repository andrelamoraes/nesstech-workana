const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const browserManager = require('./browserManager');
const pageState = require('./pageState');
const { DATA_DIR } = require('../db');

const SESSION_FILE = path.join(DATA_DIR, 'workana-session.json');
const LOGIN_URL = 'https://www.workana.com/login';

class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code; // 'twofa' | 'bad_credentials' | 'challenge' | 'unknown'
  }
}

async function newContext() {
  const opts = {};
  if (fs.existsSync(SESSION_FILE)) {
    opts.storageState = SESSION_FILE;
  }
  return browserManager.newContext(opts);
}

async function saveSession(context) {
  await context.storageState({ path: SESSION_FILE });
}

async function login(page, context, email, password) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await browserManager.jitter();

  let state = await pageState.waitOutChallenge(page);

  if (state === 'authenticated') {
    logger.info('Sessão do Workana já estava autenticada.');
    return;
  }
  if (state === 'challenge') {
    await pageState.captureDiagnostics(page, 'login-cloudflare');
    throw new AuthError(
      'A Cloudflare está segurando a página de login e não liberou em 30s. Tente de novo em alguns minutos.',
      'challenge'
    );
  }
  if (state === 'twofa') {
    await pageState.captureDiagnostics(page, 'login-2fa');
    throw new AuthError(
      'O Workana está pedindo código de verificação (2FA). O envio automático não consegue passar disso — desative o 2FA na conta ou faça um login manual para renovar a sessão.',
      'twofa'
    );
  }
  if (state === 'unknown') {
    await pageState.captureDiagnostics(page, 'login-estado-desconhecido');
    throw new AuthError(
      'A página de login carregou num estado que não reconheço (sem formulário e sem sessão). Veja o diagnóstico salvo em data/diagnostics/.',
      'unknown'
    );
  }

  await page.fill('#email-input', email);
  await browserManager.jitter(200, 600);
  await page.fill('#password-input', password);
  await browserManager.jitter(200, 600);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('form button[type="submit"]')
  ]);
  await browserManager.jitter();

  state = await pageState.waitOutChallenge(page);

  if (state === 'twofa') {
    await pageState.captureDiagnostics(page, 'login-2fa');
    throw new AuthError(
      'Login aceito, mas o Workana pediu código de verificação (2FA) — o envio automático não consegue completar isso sozinho.',
      'twofa'
    );
  }
  if (state !== 'authenticated') {
    await pageState.captureDiagnostics(page, 'login-falhou');
    throw new AuthError(
      `Login no Workana falhou (estado: ${state}). Confira email/senha nas configurações e veja o print em data/diagnostics/.`,
      state === 'anonymous' ? 'bad_credentials' : 'unknown'
    );
  }

  await saveSession(context);
  logger.info('Login no Workana realizado com sucesso.');
}

async function withPage(email, password, fn) {
  const context = await newContext();
  const page = await context.newPage();
  try {
    await login(page, context, email, password);
    return await fn(page, context);
  } finally {
    await context.close();
  }
}

module.exports = { withPage, jitter: browserManager.jitter, AuthError, SESSION_FILE };
