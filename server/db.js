const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
    aiModel: 'gemini-flash-latest'
  },
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
