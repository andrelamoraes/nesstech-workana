const fs = require('fs');
const path = require('path');
const workanaAuth = require('./workanaAuth');
const logger = require('./logger');
const { captureBaseline } = require('./workanaResponses');

const SELECTORS_FILE = path.join(__dirname, '..', '..', 'config', 'selectors.json');

function loadSelectors() {
  const raw = fs.readFileSync(SELECTORS_FILE, 'utf8');
  return JSON.parse(raw);
}

// Always triggered by an explicit user action (POST /api/jobs/:id/send) —
// this never runs on a timer or without a human clicking "Enviar" first.
async function submitProposal(email, password, job, { message, budget, deliveryDays }) {
  const selectors = loadSelectors();

  return workanaAuth.withPage(email, password, async (page) => {
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await workanaAuth.jitter(500, 1500);

    const proposalBtn = page.locator(selectors.proposalButton).first();
    await proposalBtn.click({ timeout: 10000 });
    await workanaAuth.jitter(500, 1200);

    const messageField = page.locator(selectors.messageField).first();
    await messageField.fill(message);
    await workanaAuth.jitter(300, 800);

    if (budget) {
      const budgetField = page.locator(selectors.budgetField).first();
      if (await budgetField.count()) {
        await budgetField.fill(String(budget));
        await workanaAuth.jitter(200, 500);
      }
    }

    if (deliveryDays) {
      const deliveryField = page.locator(selectors.deliveryField).first();
      if (await deliveryField.count()) {
        await deliveryField.fill(String(deliveryDays));
        await workanaAuth.jitter(200, 500);
      }
    }

    await workanaAuth.jitter(600, 1500);
    await page.locator(selectors.submitButton).first().click();
    await workanaAuth.jitter(1000, 2000);

    logger.info(`Proposta enviada para: ${job.title} (${job.url})`);

    // Snapshot the page right after sending, so future checks can tell a real
    // client reply apart from "the page just changed because I sent this".
    const baseline = await captureBaseline(page, job);
    return baseline;
  });
}

module.exports = { submitProposal };
