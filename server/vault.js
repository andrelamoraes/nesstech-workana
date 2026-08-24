const crypto = require('crypto');
const db = require('./db');

const VERIFIER_PLAINTEXT = 'nesstech-workana-vault-ok';

let sessionKey = null; // Buffer, only held in memory while the server process is unlocked

function deriveKey(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

function isInitialized() {
  const state = db.load();
  return !!state.vault;
}

function isUnlocked() {
  return sessionKey !== null;
}

function setup(password) {
  if (!password || password.length < 8) {
    throw new Error('A senha mestra precisa ter pelo menos 8 caracteres.');
  }
  const state = db.load();
  if (state.vault) {
    throw new Error('O cofre já foi inicializado.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const key = deriveKey(password, salt);
  const verifier = encryptWithKey(key, VERIFIER_PLAINTEXT);
  state.vault = { salt, verifier };
  db.save();
  sessionKey = key;
}

function unlock(password) {
  const state = db.load();
  if (!state.vault) {
    throw new Error('Cofre ainda não configurado. Use /api/setup primeiro.');
  }
  const key = deriveKey(password, state.vault.salt);
  let ok;
  try {
    ok = decryptWithKey(key, state.vault.verifier) === VERIFIER_PLAINTEXT;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('Senha mestra incorreta.');
  sessionKey = key;
}

function lock() {
  sessionKey = null;
}

function requireUnlocked() {
  if (!sessionKey) throw new Error('Cofre bloqueado. Faça /api/unlock primeiro.');
  return sessionKey;
}

function encryptWithKey(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptWithKey(key, blob) {
  const [ivB64, tagB64, dataB64] = blob.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString('utf8');
}

function encrypt(plaintext) {
  return encryptWithKey(requireUnlocked(), plaintext);
}

function decrypt(blob) {
  if (!blob) return null;
  return decryptWithKey(requireUnlocked(), blob);
}

module.exports = { isInitialized, isUnlocked, setup, unlock, lock, requireUnlocked, encrypt, decrypt };
