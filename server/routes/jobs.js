const express = require('express');
const db = require('../db');
const vault = require('../vault');
const logger = require('../services/logger');
const ai = require('../services/aiProposal');
const { submitProposal } = require('../services/workanaSubmit');
const { scanAndDraft } = require('../services/scanAndDraft');
const { checkResponses } = require('../services/workanaResponses');
const autoSend = require('../services/autoSend');
const { probeJobForm, suggestedSelectorsJson } = require('../services/selectorProbe');

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

// --- automatic sending -------------------------------------------------------
// Declared before the /:id routes so "auto" is never parsed as a job id.

router.get('/auto/status', (req, res) => {
  res.json(autoSend.statusSnapshot());
});

router.post('/auto/run', requireUnlocked, (req, res) => {
  // Long-running (opens a browser, waits between sends) — the UI polls status.
  autoSend
    .runAutoSend({ force: req.body?.force === true })
    .catch((err) => logger.error(`Falha no ciclo manual de envio automático: ${err.message}`));
  res.json({ ok: true, started: true });
});

router.post('/auto/resume', requireUnlocked, (req, res) => {
  autoSend.resume();
  res.json(autoSend.statusSnapshot());
});

// Arming is the explicit "I confirmed the selectors work" switch. Until it's
// on, every automatic cycle runs as a dry-run no matter what else is set.
router.post('/auto/arm', requireUnlocked, (req, res) => {
  const state = db.load();
  state.settings.autoSend.armed = req.body?.armed === true;
  db.save();
  logger.warn(
    state.settings.autoSend.armed
      ? 'Envio automático ARMADO — a partir de agora ele envia propostas de verdade, sem clique.'
      : 'Envio automático desarmado — voltou para dry-run.'
  );
  res.json(autoSend.statusSnapshot());
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

function credentials(res) {
  const { settings } = db.load();
  const email = vault.decrypt(settings.workanaEmailEnc);
  const password = vault.decrypt(settings.workanaPasswordEnc);
  if (!email || !password) {
    res.status(400).json({ error: 'Credenciais do Workana não configuradas.' });
    return null;
  }
  return { email, password };
}

// Manual send. `dryRun: true` fills the whole form and stops before the final
// click — the safe way to confirm config/selectors.json against a real job.
router.post('/:id/send', requireUnlocked, async (req, res) => {
  const job = findJob(req, res);
  if (!job) return;
  if (!job.draft_text || !job.draft_text.trim()) {
    return res.status(400).json({ error: 'Rascunho vazio — edite a proposta antes de enviar.' });
  }

  const creds = credentials(res);
  if (!creds) return;
  const dryRun = req.body.dryRun === true;

  try {
    const result = await submitProposal(creds.email, creds.password, job, {
      message: job.draft_text,
      budget: req.body.budget,
      deliveryDays: req.body.deliveryDays,
      dryRun
    });

    if (result.dryRun) {
      job.auto_decision = {
        decision: 'dry_run_ok',
        reason: 'formulário preenchido e validado, sem enviar',
        diagPath: result.diagPath,
        at: new Date().toISOString()
      };
      db.save();
      return res.json({ job, dryRun: true, message: 'Dry-run OK: os seletores acertaram todos os campos. Veja o print em data/diagnostics/.' });
    }

    job.status = 'sent';
    job.sent_at = new Date().toISOString();
    job.sent_by = 'manual';
    job.last_snapshot_hash = result.hash;
    job.page_snapshot = result.snapshot;
    job.project_status = result.projectStatus;
    job.last_checked_at = result.checkedAt;
    job.auto_decision = { decision: 'sent', reason: 'envio manual', evidence: result.evidence, at: job.sent_at };
    db.save();
    res.json({ job, dryRun: false });
  } catch (err) {
    logger.error(`Falha ao enviar proposta para "${job.title}": ${err.message}`);
    // Only a confirmed-failed send marks the job failed; an unverified one is
    // left alone so a retry can't silently double-submit.
    if (err.stage !== 'unverified') job.status = 'failed';
    job.auto_decision = { decision: 'error', reason: err.message, stage: err.stage || 'generic', at: new Date().toISOString() };
    db.save();
    res.status(500).json({ error: err.message, stage: err.stage || null });
  }
});

// Read-only inspection of the real proposal form. Never fills, never submits.
router.post('/:id/probe', requireUnlocked, async (req, res) => {
  const job = findJob(req, res);
  if (!job) return;
  const creds = credentials(res);
  if (!creds) return;

  try {
    const report = await probeJobForm(creds.email, creds.password, job.url);
    res.json({ report, suggested: suggestedSelectorsJson(report) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
