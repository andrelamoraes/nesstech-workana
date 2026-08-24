const fs = require('fs');
const path = require('path');
const workanaAuth = require('./workanaAuth');
const browserManager = require('./browserManager');
const pageState = require('./pageState');
const logger = require('./logger');
const { captureBaseline } = require('./workanaResponses');

const SELECTORS_FILE = path.join(__dirname, '..', '..', 'config', 'selectors.json');

class SubmitError extends Error {
  constructor(message, stage, diagPath) {
    super(message);
    this.name = 'SubmitError';
    this.stage = stage;
    this.diagPath = diagPath;
  }
}

function loadSelectors() {
  const raw = fs.readFileSync(SELECTORS_FILE, 'utf8');
  return JSON.parse(raw);
}

// Phrases that mean "you already bid on this one". Sending again would either
// silently overwrite the existing proposal or burn a second credit.
const ALREADY_APPLIED = [
  'editar proposta',
  'editar propuesta',
  'edit proposal',
  'ja enviou uma proposta',
  'ja se candidatou',
  'ya has enviado una propuesta',
  'ya postulaste',
  'sua proposta',
  'tu propuesta'
];

// Phrases that mean the job is no longer taking proposals.
const JOB_CLOSED = [
  'projeto encerrado',
  'proyecto cerrado',
  'project closed',
  'nao aceita mais propostas',
  'no acepta mas propuestas',
  'candidaturas encerradas'
];

// Phrases Workana shows after a proposal lands.
const SUCCESS_MARKERS = [
  'proposta enviada',
  'propuesta enviada',
  'proposal sent',
  'sua proposta foi enviada',
  'tu propuesta fue enviada',
  'obrigado pela sua proposta',
  'gracias por tu propuesta'
];

// Phrases meaning the account is out of proposal credits ("Conexões").
const NO_CREDITS = [
  'sem conexoes',
  'sin conexiones',
  'nao tem conexoes suficientes',
  'no tienes conexiones suficientes',
  'creditos insuficientes',
  'limite de propostas'
];

function deaccent(text) {
  return String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function matchesAny(haystack, phrases) {
  const flat = deaccent(haystack);
  return phrases.find((p) => flat.includes(deaccent(p))) || null;
}

async function pageText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

/**
 * Reads the job page and reports whether it's safe to bid, WITHOUT touching
 * anything. Used both as a preflight before every send and standalone by the
 * auto-send queue to skip jobs it shouldn't spend a credit on.
 */
async function inspectJobPage(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  const state = await pageState.waitOutChallenge(page);
  if (state !== 'authenticated') {
    throw new SubmitError(
      `A página da vaga não abriu autenticada (estado: ${state}). Não dá pra enviar proposta sem sessão válida.`,
      'preflight'
    );
  }
  await browserManager.jitter(400, 1000);

  const text = await pageText(page);
  return {
    alreadyApplied: matchesAny(text, ALREADY_APPLIED),
    closed: matchesAny(text, JOB_CLOSED),
    noCredits: matchesAny(text, NO_CREDITS),
    text
  };
}

async function requireLocator(page, selector, role, timeout = 10000) {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout });
  } catch {
    const diag = await pageState.captureDiagnostics(page, `seletor-${role}`);
    throw new SubmitError(
      `Não encontrei o campo "${role}" na página (seletor: ${selector}). Rode "npm run probe -- <url-da-vaga>" para descobrir o seletor certo e ajuste config/selectors.json.`,
      role,
      diag
    );
  }
  return locator;
}

/**
 * Fills a field and then reads it back. A fill that silently landed on the
 * wrong element (or on a read-only mirror) is the single most likely way an
 * automatic send produces a blank/garbage proposal — so we never trust it.
 */
async function fillAndVerify(page, locator, value, role) {
  await locator.fill(String(value));
  await browserManager.jitter(200, 500);
  const readBack = await locator.inputValue().catch(() => null);
  if (readBack === null) return; // not an input (contenteditable) — can't verify
  const expected = String(value).trim();
  if (readBack.trim() !== expected) {
    // Some fields reformat (currency masks). Accept if the digits still match.
    const digitsOnly = (s) => s.replace(/\D/g, '');
    if (digitsOnly(readBack) && digitsOnly(readBack) === digitsOnly(expected)) return;
    const diag = await pageState.captureDiagnostics(page, `preenchimento-${role}`);
    throw new SubmitError(
      `Preenchi o campo "${role}" mas ele não guardou o valor (esperado ${expected.length} chars, leu ${readBack.length}). Provavelmente o seletor está apontando pro elemento errado.`,
      role,
      diag
    );
  }
}

/**
 * Confirms the proposal actually landed. Without this the old code declared
 * success purely because clicking didn't throw.
 */
async function verifySubmission(page, selectors, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const text = await pageText(page);

    const credits = matchesAny(text, NO_CREDITS);
    if (credits) {
      return { ok: false, reason: 'no_credits', evidence: credits };
    }

    const success = matchesAny(text, SUCCESS_MARKERS);
    if (success) return { ok: true, evidence: success };

    // Workana flips the CTA to "Editar proposta" once a bid exists — a strong
    // signal even when no flash message is rendered.
    const applied = matchesAny(text, ALREADY_APPLIED);
    if (applied) return { ok: true, evidence: applied };

    // The message field disappearing means the form closed, which only
    // happens on a successful submit (validation errors keep it open).
    const stillOpen = await page.locator(selectors.messageField).first().isVisible().catch(() => false);
    if (!stillOpen) {
      return { ok: true, evidence: 'formulário fechou' };
    }

    await page.waitForTimeout(1000);
  }

  return { ok: false, reason: 'timeout', evidence: null };
}

/**
 * Sends one proposal.
 *
 * `dryRun: true` does everything except the final click — it opens the form,
 * fills every field, verifies the values stuck, saves a screenshot, and backs
 * out. That is how you validate config/selectors.json without spending a
 * proposal credit or posting anything to a real client.
 */
async function submitProposal(email, password, job, { message, budget, deliveryDays, dryRun = false }) {
  const selectors = loadSelectors();

  if (!message || !message.trim()) {
    throw new SubmitError('Rascunho vazio — não há proposta para enviar.', 'validation');
  }

  return workanaAuth.withPage(email, password, async (page) => {
    const pre = await inspectJobPage(page, job);

    if (pre.noCredits) {
      throw new SubmitError(
        `A conta está sem Conexões (créditos de proposta) — o Workana mostrou "${pre.noCredits}".`,
        'no_credits'
      );
    }
    if (pre.closed) {
      throw new SubmitError(`A vaga não aceita mais propostas ("${pre.closed}").`, 'job_closed');
    }
    if (pre.alreadyApplied) {
      throw new SubmitError(
        `Já existe uma proposta sua nesta vaga ("${pre.alreadyApplied}") — não vou enviar de novo.`,
        'already_applied'
      );
    }

    const proposalBtn = await requireLocator(page, selectors.proposalButton, 'proposalButton');
    await proposalBtn.click({ timeout: 10000 });
    await browserManager.jitter(600, 1400);

    const messageField = await requireLocator(page, selectors.messageField, 'messageField');
    await fillAndVerify(page, messageField, message, 'messageField');

    // Workana makes these mandatory on the real form. If the field exists and
    // we have no value, stop here instead of letting the submit bounce.
    for (const [key, value, role] of [
      [selectors.budgetField, budget, 'budgetField'],
      [selectors.deliveryField, deliveryDays, 'deliveryField']
    ]) {
      const field = page.locator(key).first();
      const exists = await field.count();
      if (!exists) continue;
      if (value === undefined || value === null || value === '') {
        const diag = await pageState.captureDiagnostics(page, `faltando-${role}`);
        throw new SubmitError(
          `O formulário tem o campo "${role}" mas nenhum valor foi informado. No envio automático, defina os padrões em Configurações › Envio automático.`,
          role,
          diag
        );
      }
      await fillAndVerify(page, field, value, role);
    }

    if (dryRun) {
      const diag = await pageState.captureDiagnostics(page, `dryrun-${job.id}`);
      logger.info(`[DRY-RUN] Formulário de "${job.title}" preenchido e validado, SEM enviar. Print em data/diagnostics/.`);
      return { dryRun: true, verified: false, diagPath: diag };
    }

    const submitBtn = await requireLocator(page, selectors.submitButton, 'submitButton');
    await browserManager.jitter(500, 1200);
    await submitBtn.click({ timeout: 10000 });

    const result = await verifySubmission(page, selectors);

    if (!result.ok) {
      const diag = await pageState.captureDiagnostics(page, `envio-nao-confirmado-${job.id}`);
      if (result.reason === 'no_credits') {
        throw new SubmitError(
          `A conta ficou sem Conexões na hora do envio ("${result.evidence}"). A proposta NÃO foi enviada.`,
          'no_credits',
          diag
        );
      }
      throw new SubmitError(
        `Cliquei em enviar mas o Workana não confirmou em 20s. NÃO estou marcando como enviada — confira o print em data/diagnostics/ antes de tentar de novo, pra não duplicar.`,
        'unverified',
        diag
      );
    }

    logger.info(`Proposta enviada e confirmada para: ${job.title} (evidência: ${result.evidence})`);

    const baseline = await captureBaseline(page, job);
    return { ...baseline, verified: true, evidence: result.evidence, dryRun: false };
  });
}

module.exports = { submitProposal, inspectJobPage, SubmitError };
