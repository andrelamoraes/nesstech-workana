const express = require('express');
const db = require('../db');
const vault = require('../vault');
const scheduler = require('../services/scheduler');
const waha = require('../services/waha');
const notifier = require('../services/opportunityNotifier');

const router = express.Router();

function requireUnlocked(req, res, next) {
  if (!vault.isUnlocked()) return res.status(401).json({ error: 'Cofre bloqueado.' });
  next();
}

router.get('/', requireUnlocked, (req, res) => {
  const { settings } = db.load();
  res.json({
    profileBio: settings.profileBio,
    keywords: settings.keywords,
    language: settings.language,
    category: settings.category,
    minBudgetUsd: settings.minBudgetUsd,
    scanIntervalMinutes: settings.scanIntervalMinutes,
    aiProvider: settings.aiProvider,
    aiModel: settings.aiModel,
    autoSend: settings.autoSend,
    whatsapp: settings.whatsapp,
    wahaConfigured: waha.isConfigured(),
    wahaUrl: waha.config().url || null,
    wahaSession: waha.config().session,
    hasWorkanaEmail: !!settings.workanaEmailEnc,
    hasWorkanaPassword: !!settings.workanaPasswordEnc,
    hasAiApiKey: !!settings.aiApiKeyEnc
  });
});

router.post('/', requireUnlocked, (req, res) => {
  const state = db.load();
  const s = state.settings;
  const body = req.body || {};

  if (typeof body.profileBio === 'string') s.profileBio = body.profileBio;
  if (Array.isArray(body.keywords)) s.keywords = body.keywords;
  if (typeof body.language === 'string') s.language = body.language;
  if (typeof body.category === 'string') s.category = body.category;
  if (typeof body.minBudgetUsd === 'number') s.minBudgetUsd = body.minBudgetUsd;
  if (typeof body.scanIntervalMinutes === 'number') s.scanIntervalMinutes = body.scanIntervalMinutes;
  if (typeof body.aiProvider === 'string') s.aiProvider = body.aiProvider;
  if (typeof body.aiModel === 'string' && body.aiModel.trim()) s.aiModel = body.aiModel.trim();

  if (body.autoSend && typeof body.autoSend === 'object') {
    const a = s.autoSend;
    const inc = body.autoSend;
    const num = (v, min, max, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };

    if (typeof inc.enabled === 'boolean') a.enabled = inc.enabled;
    if (typeof inc.dryRun === 'boolean') a.dryRun = inc.dryRun;
    // `armed` is intentionally NOT settable here — it has its own endpoint
    // (POST /api/jobs/auto/arm) so it can't be flipped by a stray settings save.
    if (inc.maxPerDay !== undefined) a.maxPerDay = num(inc.maxPerDay, 0, 50, a.maxPerDay);
    if (inc.maxPerCycle !== undefined) a.maxPerCycle = num(inc.maxPerCycle, 1, 10, a.maxPerCycle);
    if (inc.minScore !== undefined) a.minScore = num(inc.minScore, 0, 100, a.minScore);
    if (inc.minBudgetUsd !== undefined) a.minBudgetUsd = num(inc.minBudgetUsd, 0, 1e6, a.minBudgetUsd);
    if (inc.maxBidsCount !== undefined) a.maxBidsCount = num(inc.maxBidsCount, 0, 500, a.maxBidsCount);
    if (inc.fixedBudget !== undefined) a.fixedBudget = num(inc.fixedBudget, 0, 1e6, a.fixedBudget);
    if (inc.defaultDeliveryDays !== undefined) a.defaultDeliveryDays = num(inc.defaultDeliveryDays, 1, 365, a.defaultDeliveryDays);
    if (inc.minDelayBetweenSendsSec !== undefined) {
      a.minDelayBetweenSendsSec = num(inc.minDelayBetweenSendsSec, 30, 3600, a.minDelayBetweenSendsSec);
    }
    if (Array.isArray(inc.blocklist)) a.blocklist = inc.blocklist.map(String).filter(Boolean);
    if (['job_min', 'job_mid', 'job_max', 'fixed'].includes(inc.budgetStrategy)) {
      a.budgetStrategy = inc.budgetStrategy;
    }
  }

  if (body.whatsapp && typeof body.whatsapp === 'object') {
    const w = s.whatsapp;
    const inc = body.whatsapp;
    if (typeof inc.enabled === 'boolean') w.enabled = inc.enabled;
    if (Array.isArray(inc.recipients)) {
      w.recipients = [...new Set(inc.recipients.map(waha.onlyDigits).filter((d) => d.length >= 10 && d.length <= 15))];
    }
    if (inc.minScore !== undefined && Number.isFinite(Number(inc.minScore))) {
      w.minScore = Math.min(100, Math.max(0, Number(inc.minScore)));
    }
  }

  if (typeof body.workanaEmail === 'string' && body.workanaEmail.trim()) {
    s.workanaEmailEnc = vault.encrypt(body.workanaEmail.trim());
  }
  if (typeof body.workanaPassword === 'string' && body.workanaPassword) {
    s.workanaPasswordEnc = vault.encrypt(body.workanaPassword);
  }
  if (typeof body.aiApiKey === 'string' && body.aiApiKey.trim()) {
    s.aiApiKeyEnc = vault.encrypt(body.aiApiKey.trim());
  }

  db.save();
  scheduler.scheduleFromSettings();
  res.json({ ok: true });
});

router.get('/whatsapp/status', requireUnlocked, async (req, res) => {
  if (!waha.isConfigured()) return res.json({ configured: false });
  try {
    res.json({ configured: true, ...(await waha.sessionStatus()) });
  } catch (err) {
    res.json({ configured: true, error: err.message });
  }
});

router.post('/whatsapp/test', requireUnlocked, async (req, res) => {
  try {
    res.json({ results: await notifier.sendTest() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
