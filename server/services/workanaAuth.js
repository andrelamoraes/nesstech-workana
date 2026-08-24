const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const browserManager = require('./browserManager');
const { DATA_DIR } = require('../db');

const SESSION_FILE = path.join(DATA_DIR, 'workana-session.json');
const LOGIN_URL = 'https://www.workana.com/login';

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

async function isLoggedIn(page) {
  // The login form only renders when the visitor is unauthenticated.
  const loginField = await page.$('#email-input');
  return !loginField;
}

async function login(page, context, email, password) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await browserManager.jitter();

  if (await isLoggedIn(page)) {
    logger.info('Sessão do Workana já estava autenticada.');
    return;
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

  if (!(await isLoggedIn(page))) {
    throw new Error('Login no Workana falhou. Verifique email/senha nas configurações.');
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

module.exports = { withPage, jitter: browserManager.jitter };
