const db = require('../db');
const vault = require('../vault');
const logger = require('./logger');
const ai = require('./aiProposal');
const waha = require('./waha');

// Sends a WhatsApp alert (via WAHA) for every NEW job that the AI rates as a
// good opportunity: title, the budget range the client offered, and the link
// to the job page where the proposal is sent.
//
// "Good" = passed the search filters (that's how it got into db.jobs at all)
// AND scored >= settings.whatsapp.minScore. The score is the same one the
// auto-send queue uses and is stored on job.auto_score, so nothing is scored
// twice.
//
// Delivery is tracked per recipient on job.whatsapp_sent_to, so a partial
// failure only retries the numbers that didn't get it — never a duplicate.

const MAX_AGE_HOURS = 24; // never dig up old jobs (e.g. right after enabling this)
const MAX_ATTEMPTS = 3; // per job, across cycles
const MAX_NOTIFY_PER_CYCLE = 10;
const MAX_SCORE_PER_CYCLE = 15;
const ELIGIBLE_STATUSES = new Set(['new', 'drafted']);

let warnedNotConfigured = false;
let running = false;

function settingsOf(state) {
  return state.settings.whatsapp || {};
}

function recipientsOf(cfg) {
  return [...new Set((cfg.recipients || []).map(waha.onlyDigits).filter(Boolean))];
}

function formatMessage(job) {
  const lines = [
    '🔔 *Nova oportunidade no Workana*',
    '',
    `*${job.title}*`,
    `💰 ${job.budget || 'Orçamento não informado'}`
  ];
  if (job.auto_score) lines.push(`⭐ Score IA: ${job.auto_score.score}/100`);
  if (job.bids_count != null) lines.push(`📨 ${job.bids_count} proposta(s) até agora`);
  lines.push('', `👉 Enviar proposta: ${job.url}`);
  return lines.join('\n');
}

function isFresh(job) {
  const created = new Date(job.created_at).getTime();
  return Number.isFinite(created) && Date.now() - created < MAX_AGE_HOURS * 3600 * 1000;
}

function pending(job, recipients) {
  const sent = new Set(job.whatsapp_sent_to || []);
  return recipients.filter((r) => !sent.has(r));
}

// Overridable by the test suite.
const timing = { gapMs: () => 1200 + Math.random() * 1500 };

async function sleep(ms) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

/**
 * One pass. Called at the end of every scan (scheduled or manual). Never
 * throws — a WhatsApp outage must not break scanning.
 */
async function notifyNewOpportunities() {
  if (running) return { skipped: 'already_running' };
  const state = db.load();
  const cfg = settingsOf(state);
  if (!cfg.enabled) return { skipped: 'disabled' };

  if (!waha.isConfigured()) {
    if (!warnedNotConfigured) {
      logger.warn('Avisos por WhatsApp ligados, mas WAHA_URL não está definido no ambiente — nada será enviado.');
      warnedNotConfigured = true;
    }
    return { skipped: 'not_configured' };
  }

  const recipients = recipientsOf(cfg);
  if (!recipients.length) return { skipped: 'no_recipients' };
  if (!vault.isUnlocked()) return { skipped: 'locked' };

  const apiKey = vault.decrypt(state.settings.aiApiKeyEnc);
  if (!apiKey) {
    logger.warn('Avisos por WhatsApp precisam da chave de IA para pontuar as vagas — configure-a em Configurações.');
    return { skipped: 'no_ai_key' };
  }

  const minScore = Number(cfg.minScore) || 0;
  const outcome = { scored: 0, notified: 0, belowScore: 0, failed: 0 };
  let scoreAttempts = 0;
  running = true;
  try {
    const candidates = state.jobs.filter(
      (j) =>
        ELIGIBLE_STATUSES.has(j.status) &&
        isFresh(j) &&
        !j.whatsapp_skip &&
        (j.whatsapp_attempts || 0) < MAX_ATTEMPTS &&
        pending(j, recipients).length
    );

    for (const job of candidates) {
      if (outcome.notified >= MAX_NOTIFY_PER_CYCLE) break;

      if (!job.auto_score) {
        if (scoreAttempts >= MAX_SCORE_PER_CYCLE) continue;
        job.auto_score = await ai.scoreJob({
          apiKey,
          job,
          profileBio: state.settings.profileBio,
          model: state.settings.aiModel
        });
        scoreAttempts++;
        if (!job.auto_score) {
          job.whatsapp_attempts = (job.whatsapp_attempts || 0) + 1;
          db.save();
          continue; // retried next cycle, up to MAX_ATTEMPTS
        }
        outcome.scored++;
        db.save();
      }

      if (job.auto_score.score < minScore) {
        job.whatsapp_skip = `score ${job.auto_score.score} < ${minScore}`;
        outcome.belowScore++;
        db.save();
        continue;
      }

      const text = formatMessage(job);
      const errors = [];
      for (const phone of pending(job, recipients)) {
        try {
          await waha.sendText(phone, text);
          job.whatsapp_sent_to = [...(job.whatsapp_sent_to || []), phone];
          db.save();
        } catch (err) {
          errors.push(`${phone}: ${err.message}`);
        }
        await sleep(timing.gapMs()); // don't machine-gun the WhatsApp session
      }

      if (errors.length) {
        job.whatsapp_attempts = (job.whatsapp_attempts || 0) + 1;
        job.whatsapp_last_error = errors.join(' | ');
        outcome.failed++;
        logger.error(`Aviso de WhatsApp para "${job.title}" falhou (tentativa ${job.whatsapp_attempts}/${MAX_ATTEMPTS}): ${job.whatsapp_last_error}`);
      } else {
        job.whatsapp_last_error = null;
      }
      if (!pending(job, recipients).length) {
        job.whatsapp_notified_at = new Date().toISOString();
        outcome.notified++;
        logger.info(`WhatsApp: oportunidade "${job.title}" (score ${job.auto_score.score}) avisada para ${recipients.length} número(s).`);
      }
      db.save();
    }

    if (scoreAttempts || outcome.notified || outcome.failed) {
      logger.info(
        `Avisos WhatsApp: ${outcome.notified} enviada(s), ${outcome.belowScore} abaixo do score ${minScore}, ` +
          `${outcome.scored} vaga(s) pontuada(s), ${outcome.failed} com falha.`
      );
    }
    return outcome;
  } catch (err) {
    logger.error(`Erro nos avisos de WhatsApp: ${err.message}`);
    return { error: err.message };
  } finally {
    running = false;
    db.save();
  }
}

async function sendTest() {
  const cfg = settingsOf(db.load());
  const recipients = recipientsOf(cfg);
  if (!waha.isConfigured()) throw new Error('WAHA_URL não está definido no ambiente do servidor.');
  if (!recipients.length) throw new Error('Nenhum número de WhatsApp configurado.');
  const text = '✅ Teste do painel Nesstech · Workana — os avisos de novas oportunidades vão chegar neste número.';
  const results = [];
  for (const phone of recipients) {
    try {
      await waha.sendText(phone, text);
      results.push({ phone, ok: true });
    } catch (err) {
      results.push({ phone, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { notifyNewOpportunities, sendTest, formatMessage, _timing: timing };
