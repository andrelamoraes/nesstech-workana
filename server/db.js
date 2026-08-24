const fs = require('fs');
const path = require('path');

// Overridable so the test suite (and any throwaway run) can't touch the real
// vault, session and job history under ./data.
const DATA_DIR = process.env.WORKANA_DATA_DIR
  ? path.resolve(process.env.WORKANA_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_STATE = {
  vault: null, // { salt, verifier }
  settings: {
    // non-sensitive
    profileBio: '',
    keywords: [],
    language: 'pt',
    category: 'it-programming',
    minBudgetUsd: 0,
    scanIntervalMinutes: 30,
    // sensitive (encrypted blobs, set via vault)
    workanaEmailEnc: null,
    workanaPasswordEnc: null,
    aiApiKeyEnc: null,
    aiProvider: 'gemini',
    aiModel: 'gemini-flash-latest',
    // Automatic sending. Ships OFF, and even when switched on it stays in
    // dry-run until `armed` is set — see services/autoSend.js.
    autoSend: {
      enabled: false,
      dryRun: true,
      armed: false,
      maxPerDay: 5,
      maxPerCycle: 2,
      minScore: 70,
      minBudgetUsd: 0,
      maxBidsCount: 25,
      blocklist: [],
      budgetStrategy: 'job_min', // job_min | job_mid | job_max | fixed
      fixedBudget: 0,
      defaultDeliveryDays: 14,
      minDelayBetweenSendsSec: 90
    }
  },
  autoSendState: null,
  jobs: [],
  logs: []
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let state = null;

function load() {
  if (state) return state;
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    state = structuredClone(DEFAULT_STATE);
    save();
    return state;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  state = JSON.parse(raw);
  state.settings = { ...DEFAULT_STATE.settings, ...state.settings };
  // autoSend is a nested object, so the spread above would drop any key added
  // after this db.json was written — merge it one level deeper.
  state.settings.autoSend = { ...DEFAULT_STATE.settings.autoSend, ...(state.settings.autoSend || {}) };
  return state;
}

function save() {
  ensureDataDir();
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

function nextJobId() {
  const s = load();
  const max = s.jobs.reduce((m, j) => Math.max(m, j.id || 0), 0);
  return max + 1;
}

module.exports = { load, save, nextJobId, DATA_DIR };
