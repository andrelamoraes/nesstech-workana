const express = require('express');
const vault = require('../vault');
const scheduler = require('../services/scheduler');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({ initialized: vault.isInitialized(), unlocked: vault.isUnlocked() });
});

router.post('/setup', (req, res) => {
  try {
    vault.setup(req.body.password || '');
    scheduler.scheduleFromSettings();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/unlock', (req, res) => {
  try {
    vault.unlock(req.body.password || '');
    scheduler.scheduleFromSettings();
    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

router.post('/lock', (req, res) => {
  vault.lock();
  res.json({ ok: true });
});

module.exports = router;
