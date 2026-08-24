const crypto = require('crypto');
const workanaAuth = require('./workanaAuth');
const logger = require('./logger');

// Workana doesn't have a separate "inbox" for this — per their own help docs,
// once you've sent a proposal the conversation and project status both live
// on the job page itself (workana.com/job/...). So we just revisit the same
// URL we already have on file for each sent job and diff what we see.
const STATUS_PATTERNS = [
  { key: 'evaluating', patterns: ['evaluando propuestas', 'avaliando propostas', 'evaluating proposals'] },
  { key: 'awaiting_deposit', patterns: ['esperando depósito en garantía', 'aguardando depósito em garantia'] },
  { key: 'working', patterns: ['trabajando', 'trabalhando'] },
  { key: 'finished', patterns: ['finalizado', 'finalizada'] },
  { key: 'cancelled', patterns: ['cancelado', 'cancelada'] }
];

const STATUS_LABELS = {
  evaluating: 'Avaliando propostas',
  awaiting_deposit: 'Aguardando depósito em garantia',
  working: 'Trabalhando',
  finished: 'Finalizado',
  cancelled: 'Cancelado'
};

function detectProjectStatus(pageText) {
  const lower = pageText.toLowerCase();
  for (const entry of STATUS_PATTERNS) {
    if (entry.patterns.some((p) => lower.includes(p))) return entry.key;
  }
  return null;
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function snapshotJobPage(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  await workanaAuth.jitter(700, 1500);
  const pageText = await page.evaluate(() => document.body.innerText);
  return pageText;
}

// Called right after a proposal is sent, using the same already-logged-in
// page, so the baseline reflects "just after I sent it" — before comparing
// future snapshots against it to catch the client's first reply.
async function captureBaseline(page, job) {
  const pageText = await snapshotJobPage(page, job);
  return {
    hash: hashText(pageText),
    snapshot: pageText.slice(0, 4000),
    projectStatus: detectProjectStatus(pageText),
    checkedAt: new Date().toISOString()
  };
}

// Called periodically (scheduler) and on-demand (manual button) for every
// job already marked 'sent' or 'responded'. Never sends anything — read only.
async function checkResponses(email, password, jobs) {
  const targets = jobs.filter((j) => j.status === 'sent' || j.status === 'responded');
  if (!targets.length) return { checked: 0, newResponses: 0 };

  let newResponses = 0;

  await workanaAuth.withPage(email, password, async (page) => {
    for (const job of targets) {
      try {
        const pageText = await snapshotJobPage(page, job);
        const hash = hashText(pageText);
        const projectStatus = detectProjectStatus(pageText);

        job.project_status = projectStatus;
        job.last_checked_at = new Date().toISOString();
        job.page_snapshot = pageText.slice(0, 4000);

        if (!job.last_snapshot_hash) {
          // No baseline (older job sent before this feature existed) — set
          // one now but don't claim a "new" response we can't actually prove.
          job.last_snapshot_hash = hash;
        } else if (hash !== job.last_snapshot_hash) {
          job.last_snapshot_hash = hash;
          job.status = 'responded';
          job.responded_at = new Date().toISOString();
          newResponses++;
          logger.info(`Nova atividade na vaga "${job.title}"${projectStatus ? ` (status: ${STATUS_LABELS[projectStatus]})` : ''}.`);
        }
      } catch (err) {
        logger.error(`Falha ao checar resposta da vaga "${job.title}": ${err.message}`);
      }
      await workanaAuth.jitter(500, 1200);
    }
  });

  return { checked: targets.length, newResponses };
}

module.exports = { checkResponses, captureBaseline, detectProjectStatus, STATUS_LABELS };
