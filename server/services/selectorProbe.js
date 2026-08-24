const fs = require('fs');
const path = require('path');
const workanaAuth = require('./workanaAuth');
const browserManager = require('./browserManager');
const pageState = require('./pageState');
const logger = require('./logger');

const SELECTORS_FILE = path.join(__dirname, '..', '..', 'config', 'selectors.json');

// The proposal form only renders for an authenticated user, which is why the
// shipped selectors were never verifiable from outside. This opens a real job
// page with your session and reports what's actually there, so you can fix
// config/selectors.json in one pass instead of inspecting field by field.

function describeElements(role) {
  return (sel) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const rect = el.getBoundingClientRect();
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        name: el.getAttribute('name') || null,
        type: el.getAttribute('type') || null,
        placeholder: el.getAttribute('placeholder') || null,
        classes: (el.className || '').toString().slice(0, 120) || null,
        text: (el.innerText || el.value || '').trim().slice(0, 80) || null,
        visible: rect.width > 0 && rect.height > 0,
        href: el.getAttribute('href') || null
      });
    }
    return out;
  };
}

// Broad sweeps per role — deliberately wider than the configured selectors, so
// the report shows what you COULD target, not just whether the guess matched.
const SWEEPS = {
  proposalButton: "a, button, input[type='submit'], input[type='button']",
  messageField: 'textarea, [contenteditable="true"]',
  budgetField: "input[type='number'], input[type='text'], input[type='tel']",
  deliveryField: "input[type='number'], input[type='text'], select",
  submitButton: "button, input[type='submit']"
};

const HINTS = {
  proposalButton: /proposta|propuesta|proposal|postular|candidat|aplicar|apply|enviar/i,
  messageField: /mensagem|mensaje|message|proposta|propuesta|carta|cover/i,
  budgetField: /valor|orcament|orçament|presupuest|budget|bid|monto|preco|preço|amount/i,
  deliveryField: /prazo|plazo|dias|days|entrega|delivery|deadline/i,
  submitButton: /enviar|send|submit|publicar|confirmar/i
};

function scoreCandidate(cand, role) {
  const hint = HINTS[role];
  const blob = [cand.id, cand.name, cand.placeholder, cand.classes, cand.text, cand.href]
    .filter(Boolean)
    .join(' ');
  let score = 0;
  if (hint.test(blob)) score += 10;
  if (cand.visible) score += 5;
  if (cand.name || cand.id) score += 3;
  return score;
}

function suggestSelector(cand) {
  if (cand.id) return `#${cand.id}`;
  if (cand.name) return `${cand.tag}[name='${cand.name}']`;
  if (cand.text) return `${cand.tag}:has-text('${cand.text.split('\n')[0].slice(0, 30)}')`;
  return null;
}

async function collectRoles(page, selectors) {
  const report = {};
  for (const role of Object.keys(SWEEPS)) {
    const configured = selectors[role];
    const configuredMatches = configured
      ? await page.$$eval(configured, describeElements(role)).catch(() => [])
      : [];
    const all = await page.$$eval(SWEEPS[role], describeElements(role)).catch(() => []);

    const ranked = all
      .map((c) => ({ ...c, _score: scoreCandidate(c, role), suggestion: suggestSelector(c) }))
      .filter((c) => c._score >= 10)
      .sort((a, b) => b._score - a._score)
      .slice(0, 8);

    report[role] = {
      configured,
      configuredMatchCount: configuredMatches.length,
      configuredFirstMatch: configuredMatches[0] || null,
      candidates: ranked
    };
  }
  return report;
}

/**
 * Opens the job page, then opens the proposal form (using whatever
 * proposalButton is currently configured, or the best guess found on the
 * page), and reports the real field candidates for every role.
 *
 * Read-only: it never fills anything and never clicks a submit control.
 */
async function probeJobForm(email, password, jobUrl) {
  const selectors = JSON.parse(fs.readFileSync(SELECTORS_FILE, 'utf8'));

  return workanaAuth.withPage(email, password, async (page) => {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded' });
    const state = await pageState.waitOutChallenge(page);
    if (state !== 'authenticated') {
      throw new Error(`A vaga não abriu autenticada (estado: ${state}) — não dá pra ver o formulário de proposta.`);
    }
    await browserManager.jitter(500, 1200);

    const beforeForm = await collectRoles(page, selectors);
    const listingDiag = await pageState.captureDiagnostics(page, 'probe-pagina-da-vaga');

    // Try to open the proposal form so the message/budget/delivery fields
    // exist in the DOM at all.
    let openedWith = null;
    let openError = null;
    const candidates = [selectors.proposalButton, ...beforeForm.proposalButton.candidates
      .map((c) => c.suggestion)
      .filter(Boolean)];

    for (const sel of candidates) {
      if (!sel) continue;
      try {
        const loc = page.locator(sel).first();
        if (!(await loc.count())) continue;
        await loc.click({ timeout: 6000 });
        await browserManager.jitter(1200, 2200);
        const hasField = await page.locator(SWEEPS.messageField).count();
        if (hasField) {
          openedWith = sel;
          break;
        }
      } catch (err) {
        openError = err.message;
      }
    }

    const afterForm = await collectRoles(page, selectors);
    const formDiag = await pageState.captureDiagnostics(page, 'probe-formulario-de-proposta');

    logger.info(
      openedWith
        ? `Probe: formulário de proposta aberto com "${openedWith}".`
        : `Probe: não consegui abrir o formulário de proposta${openError ? ` (${openError})` : ''}.`
    );

    return {
      url: jobUrl,
      openedWith,
      openError,
      formOpened: !!openedWith,
      beforeForm,
      afterForm,
      diagnostics: { listing: listingDiag, form: formDiag }
    };
  });
}

// Turns the probe result into the exact JSON block to paste into
// config/selectors.json, using the top-ranked candidate per role.
function suggestedSelectorsJson(report) {
  const out = {};
  for (const role of Object.keys(SWEEPS)) {
    const info = report.afterForm[role];
    if (info.configuredMatchCount === 1 && info.configuredFirstMatch?.visible) {
      out[role] = info.configured; // current value already resolves uniquely
      continue;
    }
    const best = info.candidates.find((c) => c.suggestion && c.visible) || info.candidates[0];
    out[role] = best?.suggestion || info.configured || null;
  }
  return out;
}

module.exports = { probeJobForm, suggestedSelectorsJson };
