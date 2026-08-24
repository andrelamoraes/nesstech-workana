const express = require('express');
const db = require('../db');
const vault = require('../vault');
const scheduler = require('../services/scheduler');

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

module.exports = router;
