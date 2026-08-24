const db = require('../db');
const vault = require('../vault');
const logger = require('./logger');
const ai = require('./aiProposal');
const browserManager = require('./browserManager');
const { submitProposal, SubmitError } = require('./workanaSubmit');
const { AuthError } = require('./workanaAuth');

// --- budget parsing ---------------------------------------------------------

// Workana renders budgets as "USD 100 - 250", "Menos de USD 100",
// "Mais de USD 5.000", "USD 750". Returns { min, max } in the stated currency
// (we don't convert — the field on the form is in the same currency).
function parseBudgetRange(budgetStr) {
  if (!budgetStr) return { min: null, max: null };
  const nums = (budgetStr.match(/[\d][\d.,]*/g) || [])
    .map((n) => parseFloat(n.replace(/\./g, '').replace(',', '.')))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return { min: null, max: null };

  const lower = budgetStr.toLowerCase();
  if (/menos de|less than|menor que/.test(lower)) return { min: null, max: nums[0] };
  if (/mais de|more than|mayor que|más de/.test(lower)) return { min: nums[0], max: null };
  if (nums.length >= 2) return { min: Math.min(...nums), max: Math.max(...nums) };
  return { min: nums[0], max: nums[0] };
}

function resolveBudget(job, cfg) {
  const { min, max } = parseBudgetRange(job.budget);
  // A fixed budget of 0 means "not configured", not "propose zero" — treating
  // it as a real value would make an unreadable job budget silently become a
  // proposal worth nothing. Anything falsy here must fall through to null so
  // the queue skips the job instead.
  const fallback = Number(cfg.fixedBudget) > 0 ? Number(cfg.fixedBudget) : null;

  switch (cfg.budgetStrategy) {
    case 'fixed':
      return fallback;
    case 'job_max':
      return max ?? min ?? fallback;
    case 'job_mid':
      if (min != null && max != null) return Math.round((min + max) / 2);
      return max ?? min ?? fallback;
    case 'job_min':
    default:
      return min ?? max ?? fallback;
  }
}

// --- daily counter / circuit breaker ----------------------------------------

function localDateKey(d = new Date()) {
  // Local date, not UTC — "5 per day" should mean the user's day.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getState() {
  const state = db.load();
  if (!state.autoSendState) {
    state.autoSendState = {
      date: localDateKey(),
      sentToday: 0,
      consecutiveFailures: 0,
      pausedUntil: null,
      pausedReason: null,
      lastRunAt: null,
      lastVerifiedSendAt: null
    };
  }
  if (state.autoSendState.date !== localDateKey()) {
    state.autoSendState.date = localDateKey();
    state.autoSendState.sentToday = 0;
  }
  return state.autoSendState;
}

// How long to stay down per failure class. Auth/credit problems need a human,
// so they pause long rather than retrying into a wall.
const PAUSE_MINUTES = {
  no_credits: 12 * 60,
  twofa: 24 * 60,
  bad_credentials: 24 * 60,
  challenge: 60,
  unverified: 6 * 60,
  selector: 12 * 60,
  generic: 90
};

const FAILURE_THRESHOLD = 3;

function pause(autoState, minutes, reason) {
  autoState.pausedUntil = new Date(Date.now() + minutes * 60000).toISOString();
  autoState.pausedReason = reason;
  logger.error(`Envio automático PAUSADO por ${minutes} min: ${reason}`);
}

function isPaused(autoState) {
  if (!autoState.pausedUntil) return false;
  if (new Date(autoState.pausedUntil).getTime() > Date.now()) return true;
  autoState.pausedUntil = null;
  autoState.pausedReason = null;
  return false;
}

function classifyError(err) {
  if (err instanceof AuthError) return err.code || 'generic';
  if (err instanceof SubmitError) {
    if (['proposalButton', 'messageField', 'budgetField', 'deliveryField', 'submitButton'].includes(err.stage)) {
      return 'selector';
    }
    return err.stage || 'generic';
  }
  return 'generic';
}

// Outcomes that mean "this particular job isn't sendable" rather than "the
// system is broken" — they must not trip the circuit breaker.
const JOB_LEVEL_STAGES = new Set(['already_applied', 'job_closed', 'validation']);

// --- eligibility -------------------------------------------------------------

function hardFilters(job, cfg) {
  if (!job.draft_text || !job.draft_text.trim()) return 'rascunho vazio';

  if (cfg.maxBidsCount && (job.bids_count ?? 0) > cfg.maxBidsCount) {
    return `${job.bids_count} propostas (teto ${cfg.maxBidsCount})`;
  }

  if (cfg.minBudgetUsd) {
    const { min, max } = parseBudgetRange(job.budget);
    const ceiling = max ?? min;
    if (ceiling != null && ceiling < cfg.minBudgetUsd) {
      return `orçamento ${job.budget} abaixo do mínimo ${cfg.minBudgetUsd}`;
    }
  }

  const blocked = (cfg.blocklist || []).filter(Boolean).find((word) => {
    const haystack = `${job.title} ${job.description} ${(job.skills || []).join(' ')}`.toLowerCase();
    return haystack.includes(word.toLowerCase());
  });
  if (blocked) return `contém termo bloqueado "${blocked}"`;

  return null;
}

// --- the queue ---------------------------------------------------------------

let running = false;

/**
 * One pass of the automatic queue. Called by the scheduler right after each
 * scan, and on demand from the panel.
 *
 * Safety layers, in order: enabled -> armed (or dry-run) -> not paused ->
 * daily cap -> per-cycle cap -> hard filters -> AI score -> on-page preflight
 * (already applied / closed / no credits) -> fill verification -> submit
 * confirmation. A send is only recorded as 'sent' when Workana confirmed it.
 */
async function runAutoSend({ force = false } = {}) {
  if (running) {
    logger.warn('Envio automático já está rodando — ignorando disparo duplicado.');
    return { skipped: 'already_running' };
  }

  const state = db.load();
  const cfg = state.settings.autoSend || {};
  const autoState = getState();

  if (!cfg.enabled && !force) return { skipped: 'disabled' };
  if (!vault.isUnlocked()) return { skipped: 'locked' };

  // The gate that keeps this from firing blind: until one proposal has been
  // confirmed end-to-end (manual send or dry-run + explicit arming), real
  // sends are refused and everything runs as a dry-run instead.
  const effectiveDryRun = cfg.dryRun || !cfg.armed;
  if (effectiveDryRun && !cfg.dryRun) {
    logger.warn('Envio automático ainda não foi "armado" — rodando em modo dry-run até você confirmar os seletores.');
  }

  if (!effectiveDryRun && isPaused(autoState)) {
    return { skipped: 'paused', until: autoState.pausedUntil, reason: autoState.pausedReason };
  }

  const email = vault.decrypt(state.settings.workanaEmailEnc);
  const password = vault.decrypt(state.settings.workanaPasswordEnc);
  if (!email || !password) return { skipped: 'no_credentials' };
  const apiKey = vault.decrypt(state.settings.aiApiKeyEnc);

  const maxPerDay = Number(cfg.maxPerDay) || 0;
  const remainingToday = effectiveDryRun ? Infinity : Math.max(0, maxPerDay - autoState.sentToday);
  if (remainingToday <= 0) {
    logger.info(`Teto diário de envios automáticos atingido (${maxPerDay}).`);
    return { skipped: 'daily_cap', sentToday: autoState.sentToday };
  }

  const perCycle = Math.max(1, Number(cfg.maxPerCycle) || 1);
  const budgetOfWork = Math.min(perCycle, remainingToday);

  running = true;
  autoState.lastRunAt = new Date().toISOString();

  const outcome = { evaluated: 0, sent: 0, wouldSend: 0, skipped: 0, failed: 0, dryRun: effectiveDryRun };

  try {
    const candidates = state.jobs
      .filter((j) => j.status === 'drafted')
      .filter((j) => !j.auto_decision || j.auto_decision.decision === 'would_send' || j.auto_decision.retryable)
      .sort((a, b) => (b.auto_score?.score ?? -1) - (a.auto_score?.score ?? -1));

    for (const job of candidates) {
      if (outcome.sent + outcome.wouldSend >= budgetOfWork) break;
      outcome.evaluated++;

      const blockReason = hardFilters(job, cfg);
      if (blockReason) {
        job.auto_decision = { decision: 'skip', reason: blockReason, at: new Date().toISOString() };
        outcome.skipped++;
        db.save();
        continue;
      }

      if (!job.auto_score) {
        job.auto_score = await ai.scoreJob({
          apiKey,
          job,
          profileBio: state.settings.profileBio,
          model: state.settings.aiModel
        });
        db.save();
      }

      const minScore = Number(cfg.minScore) || 0;
      if (!job.auto_score) {
        job.auto_decision = {
          decision: 'skip',
          reason: 'não consegui pontuar a vaga com a IA',
          retryable: true,
          at: new Date().toISOString()
        };
        outcome.skipped++;
        db.save();
        continue;
      }
      if (job.auto_score.score < minScore) {
        job.auto_decision = {
          decision: 'skip',
          reason: `score ${job.auto_score.score} < mínimo ${minScore}`,
          at: new Date().toISOString()
        };
        outcome.skipped++;
        db.save();
        continue;
      }

      const budget = resolveBudget(job, cfg);
      const deliveryDays = Number(cfg.defaultDeliveryDays) || null;
      if (budget == null) {
        job.auto_decision = {
          decision: 'skip',
          reason: 'não consegui definir um valor de proposta (orçamento da vaga ilegível e sem valor fixo configurado)',
          at: new Date().toISOString()
        };
        outcome.skipped++;
        db.save();
        continue;
      }

      try {
        const result = await submitProposal(email, password, job, {
          message: job.draft_text,
          budget,
          deliveryDays,
          dryRun: effectiveDryRun
        });

        if (result.dryRun) {
          job.auto_decision = {
            decision: 'would_send',
            reason: `score ${job.auto_score.score}`,
            budget,
            deliveryDays,
            diagPath: result.diagPath,
            at: new Date().toISOString()
          };
          outcome.wouldSend++;
          logger.info(`[DRY-RUN] Enviaria proposta para "${job.title}" (valor ${budget}, ${deliveryDays}d, score ${job.auto_score.score}).`);
        } else {
          job.status = 'sent';
          job.sent_at = new Date().toISOString();
          job.sent_by = 'auto';
          job.sent_budget = budget;
          job.sent_delivery_days = deliveryDays;
          job.last_snapshot_hash = result.hash;
          job.page_snapshot = result.snapshot;
          job.project_status = result.projectStatus;
          job.last_checked_at = result.checkedAt;
          job.auto_decision = {
            decision: 'sent',
            reason: `score ${job.auto_score.score}`,
            evidence: result.evidence,
            at: new Date().toISOString()
          };
          autoState.sentToday++;
          autoState.consecutiveFailures = 0;
          autoState.lastVerifiedSendAt = job.sent_at;
          outcome.sent++;
          logger.info(`Envio automático ${autoState.sentToday}/${maxPerDay} hoje: "${job.title}".`);
        }
        db.save();
      } catch (err) {
        const stage = classifyError(err);
        job.auto_decision = { decision: 'error', reason: err.message, stage, at: new Date().toISOString() };

        if (JOB_LEVEL_STAGES.has(stage)) {
          // Not a system fault — retire the job, keep the queue healthy.
          job.status = 'skipped';
          outcome.skipped++;
          logger.warn(`Pulando "${job.title}": ${err.message}`);
        } else {
          job.status = 'failed';
          outcome.failed++;
          autoState.consecutiveFailures++;
          logger.error(`Falha no envio automático de "${job.title}" [${stage}]: ${err.message}`);

          // Credit/auth problems are pointless to retry — stop immediately.
          if (['no_credits', 'twofa', 'bad_credentials'].includes(stage)) {
            pause(autoState, PAUSE_MINUTES[stage], err.message);
            db.save();
            break;
          }
          if (autoState.consecutiveFailures >= FAILURE_THRESHOLD) {
            pause(
              autoState,
              PAUSE_MINUTES[stage] || PAUSE_MINUTES.generic,
              `${autoState.consecutiveFailures} falhas seguidas (última: ${err.message})`
            );
            db.save();
            break;
          }
        }
        db.save();
      }

      // Space out sends so the account doesn't look like a burst script.
      const gapSec = Math.max(30, Number(cfg.minDelayBetweenSendsSec) || 90);
      if (outcome.sent + outcome.wouldSend < budgetOfWork) {
        await browserManager.jitter(gapSec * 1000, gapSec * 1000 * 1.6);
      }
    }

    logger.info(
      `Ciclo de envio automático${effectiveDryRun ? ' (DRY-RUN)' : ''}: ${outcome.evaluated} avaliadas, ` +
        `${outcome.sent} enviada(s), ${outcome.wouldSend} marcada(s) "enviaria", ${outcome.skipped} puladas, ${outcome.failed} com erro.`
    );
    return outcome;
  } finally {
    running = false;
    db.save();
  }
}

function statusSnapshot() {
  const state = db.load();
  const cfg = state.settings.autoSend || {};
  const autoState = getState();
  return {
    enabled: !!cfg.enabled,
    dryRun: !!cfg.dryRun,
    armed: !!cfg.armed,
    effectiveDryRun: !!(cfg.dryRun || !cfg.armed),
    sentToday: autoState.sentToday,
    maxPerDay: Number(cfg.maxPerDay) || 0,
    consecutiveFailures: autoState.consecutiveFailures,
    pausedUntil: autoState.pausedUntil,
    pausedReason: autoState.pausedReason,
    lastRunAt: autoState.lastRunAt,
    lastVerifiedSendAt: autoState.lastVerifiedSendAt,
    running
  };
}

function resume() {
  const autoState = getState();
  autoState.pausedUntil = null;
  autoState.pausedReason = null;
  autoState.consecutiveFailures = 0;
  db.save();
  logger.info('Envio automático retomado manualmente.');
}

module.exports = { runAutoSend, statusSnapshot, resume, parseBudgetRange, resolveBudget };
