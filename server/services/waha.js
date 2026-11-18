const logger = require('./logger');

// Thin client for a WAHA (WhatsApp HTTP API) instance — normally the one
// running on the same server, so the default is localhost. Connection details
// come from the environment (see deploy/env.example), not from db.json: the
// API key is a server secret and the URL is a deploy-time fact.
//
//   WAHA_URL      http://127.0.0.1:3000
//   WAHA_API_KEY  value of WAHA_API_KEY configured in WAHA (optional)
//   WAHA_SESSION  WAHA session name (default "default")

function config() {
  return {
    url: (process.env.WAHA_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.WAHA_API_KEY || '',
    session: process.env.WAHA_SESSION || 'default'
  };
}

function isConfigured() {
  return !!config().url;
}

class WahaError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WahaError';
    this.status = status;
  }
}

async function request(method, path, body) {
  const { url, apiKey } = config();
  if (!url) throw new WahaError('WAHA_URL não configurado.');
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  if (body) headers['Content-Type'] = 'application/json';

  let resp;
  try {
    resp = await fetch(url + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    throw new WahaError(`WAHA inacessível em ${url}: ${err.cause?.code || err.message}`);
  }
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    const hint = resp.status === 401 ? ' (confira WAHA_API_KEY)' : '';
    throw new WahaError(`WAHA respondeu ${resp.status}${hint}: ${text.slice(0, 200)}`, resp.status);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function onlyDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// Brazilian mobile numbers are a trap: accounts registered before the 9th
// digit was added still live under the 8-digit WhatsApp ID (5511 9xxxx-xxxx is
// "551197135040@c.us", not "5511997135040@c.us"). Sending to the wrong ID
// silently goes nowhere, so ask WAHA which ID the number really has and cache
// the answer for the life of the process.
const chatIdCache = new Map();

async function resolveChatId(phone) {
  const digits = onlyDigits(phone);
  if (!digits) throw new WahaError(`Número inválido: "${phone}"`);
  if (chatIdCache.has(digits)) return chatIdCache.get(digits);

  const { session } = config();
  let chatId = `${digits}@c.us`;
  try {
    const r = await request('GET', `/api/contacts/check-exists?phone=${digits}&session=${encodeURIComponent(session)}`);
    if (r && r.numberExists === false) {
      throw new WahaError(`O número ${digits} não tem WhatsApp (segundo o WAHA).`);
    }
    if (r && r.chatId) chatId = r.chatId;
  } catch (err) {
    // A definite "no WhatsApp" is final; anything else (old WAHA build without
    // the endpoint, transient error) falls back to the literal number.
    if (err instanceof WahaError && /não tem WhatsApp/.test(err.message)) throw err;
    logger.warn(`Não consegui confirmar o ID de WhatsApp de ${digits} (${err.message}) — usando ${chatId}.`);
    return chatId; // don't cache a guess
  }
  chatIdCache.set(digits, chatId);
  return chatId;
}

async function sendText(phone, text) {
  const { session } = config();
  const chatId = await resolveChatId(phone);
  return request('POST', '/api/sendText', { session, chatId, text, linkPreview: true });
}

async function sessionStatus() {
  const { session } = config();
  const r = await request('GET', `/api/sessions/${encodeURIComponent(session)}`);
  return { session, status: r.status || 'UNKNOWN', me: r.me || null };
}

module.exports = { isConfigured, config, sendText, sessionStatus, resolveChatId, onlyDigits, WahaError, _chatIdCache: chatIdCache };
