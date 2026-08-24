const express = require('express');
const db = require('../db');
const vault = require('../vault');
const logger = require('../services/logger');
const ai = require('../services/aiProposal');
const { submitProposal } = require('../services/workanaSubmit');
const { scanAndDraft } = require('../services/scanAndDraft');
const { checkResponses } = require('../services/workanaResponses');

const router = express.Router();

function requireUnlocked(req, res, next) {
  if (!vault.isUnlocked()) return res.status(401).json({ error: 'Cofre bloqueado.' });
  next();
}

function findJob(req, res) {
  const { jobs } = db.load();
  const job = jobs.find((j) => j.id === Number(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'Vaga não encontrada.' });
    return null;
  }
  return job;
}

router.get('/', (req, res) => {
  const { jobs } = db.load();
  const { status } = req.query;
  const filtered = status ? jobs.filter((j) => j.status === status) : jobs;
  res.json(filtered);
});

router.post('/scan', requireUnlocked, async (req, res) => {
  // Fire-and-forget: scanning + drafting can take a while, the UI polls GET /api/jobs.
  scanAndDraft().catch((err) => logger.error(`Falha na varredura manual: ${err.message}`));
  res.json({ ok: true, started: true });
});

router.post('/check-responses', requireUnlocked, async (req, res) => {
  const { settings, jobs } = db.load();
  const email = vault.decrypt(settings.workanaEmailEnc);
  const password = vault.decrypt(settings.workanaPasswordEnc);
  if (!email || !password) {
    return res.status(400).json({ error: 'Credenciais do Workana não configuradas.' });
  }
  checkResponses(email, password, jobs)
    .then((result) => {
      db.save();
      logger.info(`Verificação de respostas concluída: ${result.checked} vaga(s) checada(s), ${result.newResponses} com atividade nova.`);
    })
    .catch((err) => logger.error(`Falha ao checar respostas: ${err.message}`));
  res.json({ ok: true, started: true });
});

router.post('/:id/draft', requireUnlocked, async (req, res) => {
  const job = findJob(req, res);
  if (!job) return;
  const { settings } = db.load();
  const apiKey = vault.decrypt(settings.aiApiKeyEnc);
  try {
    const result = await ai.generateProposal({ apiKey, job, profileBio: settings.profileBio, model: settings.aiModel });
    job.draft_text = result.text;
    job.status = 'drafted';
    if (result.modelUsed && result.modelUsed !== settings.aiModel) {
      settings.aiModel = result.modelUsed;
    }
    db.save();
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const job = findJob(req, res);
  if (!job) return;
  if (typeof req.body.draft_text === 'string') job.draft_text = req.body.draft_text;
  db.save();
  res.json(job);
});

router.post('/:id/skip', (req, res) => {
  const job = findJob(req, res);
  if (!job) return;
  job.status = 'skipped';
  db.save();
  res.json(job);
});

// The only route that actually touches Workana with a proposal — always a
// direct response to a click from the dashboard, never called by the scheduler.
router.post('/:id/send', requireUnlocked, async (req, res) => {
  const job = findJob(req, res);
  if (!job) return;
  if (!job.draft_text || !job.draft_text.trim()) {
    return res.status(400).json({ error: 'Rascunho vazio — edite a proposta antes de enviar.' });
  }

  const { settings } = db.load();
  const email = vault.decrypt(settings.workanaEmailEnc);
  const password = vault.decrypt(settings.workanaPasswordEnc);
  if (!email || !password) {
    return res.status(400).json({ error: 'Credenciais do Workana não configuradas.' });
  }

  try {
    const baseline = await submitProposal(email, password, job, {
      message: job.draft_text,
      budget: req.body.budget,
      deliveryDays: req.body.deliveryDays
    });
    job.status = 'sent';
    job.sent_at = new Date().toISOString();
    job.last_snapshot_hash = baseline.hash;
    job.page_snapshot = baseline.snapshot;
    job.project_status = baseline.projectStatus;
    job.last_checked_at = baseline.checkedAt;
    db.save();
    res.json(job);
  } catch (err) {
    logger.error(`Falha ao enviar proposta para "${job.title}": ${err.message}`);
    job.status = 'failed';
    db.save();
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
