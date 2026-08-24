const db = require('../db');
const vault = require('../vault');
const logger = require('./logger');
const scraper = require('./workanaScraper');
const ai = require('./aiProposal');

function parseMinBudget(budgetStr) {
  if (!budgetStr) return null;
  const nums = budgetStr.match(/[\d.]+/g);
  if (!nums) return null;
  return parseFloat(nums[0].replace(/\./g, ''));
}

function matchesFilters(job, settings) {
  const kws = (settings.keywords || []).map((k) => k.toLowerCase()).filter(Boolean);
  if (kws.length) {
    const haystack = `${job.title} ${job.description} ${(job.skills || []).join(' ')}`.toLowerCase();
    if (!kws.some((k) => haystack.includes(k))) return false;
  }
  if (settings.minBudgetUsd) {
    const min = parseMinBudget(job.budget);
    if (min !== null && min < settings.minBudgetUsd) return false;
  }
  return true;
}

// Shared by both "draft this brand new job" and "retry a job whose draft
// failed earlier" (usually because the AI API was temporarily overloaded).
async function draftJob(job, settings, aiApiKey) {
  try {
    const result = await ai.generateProposal({ apiKey: aiApiKey, job, profileBio: settings.profileBio, model: settings.aiModel });
    job.draft_text = result.text;
    job.status = 'drafted';
    if (result.modelUsed && result.modelUsed !== settings.aiModel) {
      settings.aiModel = result.modelUsed;
    }
    db.save();
    return true;
  } catch (err) {
    logger.error(`Falha ao gerar proposta para "${job.title}": ${err.message}`);
    return false;
  }
}

// Cap per scan so a long streak of AI failures can't turn every scan into a
// marathon of retries — the rest just wait for the next cycle.
const MAX_RETRY_DRAFTS_PER_SCAN = 8;

let scanning = false;

async function scanAndDraft() {
  if (scanning) {
    logger.warn('Varredura já em andamento, ignorando novo disparo.');
    return { skipped: true };
  }
  scanning = true;
  try {
    const state = db.load();
    const settings = state.settings;

    if (!vault.isUnlocked()) throw new Error('Cofre bloqueado — não é possível ler as credenciais.');

    const aiApiKey = vault.decrypt(settings.aiApiKeyEnc);

    const found = await scraper.scanJobs({
      language: settings.language || 'pt',
      category: settings.category || '',
      maxPages: 2
    });

    let added = 0;
    let drafted = 0;

    for (const item of found) {
      if (!matchesFilters(item, settings)) continue;

      const exists = state.jobs.find((j) => j.workana_slug === item.slug);
      if (exists) continue;

      // The listing page only has a truncated preview — grab the real,
      // complete description (and deadline, if stated) from the job's own
      // page before saving it or handing it to the AI.
      let fullDescription = item.description;
      let deadline = null;
      try {
        const full = await scraper.fetchFullDescription(item.url);
        if (full.description) fullDescription = full.description;
        deadline = full.deadline;
      } catch (err) {
        logger.warn(`Não consegui abrir a descrição completa de "${item.title}", usando o resumo da listagem: ${err.message}`);
      }

      const job = {
        id: db.nextJobId(),
        workana_slug: item.slug,
        title: item.title,
        url: item.url,
        description: fullDescription,
        deadline,
        skills: item.skills,
        budget: item.budget,
        country: item.country,
        published_at: item.publishedAt,
        bids_count: item.bidsCount,
        status: 'new',
        draft_text: '',
        sent_at: null,
        project_status: null,
        last_snapshot_hash: null,
        page_snapshot: '',
        last_checked_at: null,
        responded_at: null,
        created_at: new Date().toISOString()
      };
      state.jobs.unshift(job);
      added++;
      db.save();

      if (aiApiKey) {
        const ok = await draftJob(job, settings, aiApiKey);
        if (ok) drafted++;
      }
    }

    // Jobs whose draft failed earlier (typically the AI API being briefly
    // overloaded) sit in 'new' with no draft_text — quietly retry a batch of
    // them here so a temporary outage self-heals on the next scan instead of
    // requiring you to notice and click "Gerar novo rascunho" yourself.
    let retried = 0;
    if (aiApiKey) {
      const stale = state.jobs.filter((j) => j.status === 'new' && !j.draft_text).slice(0, MAX_RETRY_DRAFTS_PER_SCAN);
      for (const job of stale) {
        const ok = await draftJob(job, settings, aiApiKey);
        if (ok) retried++;
      }
    }

    logger.info(`Varredura concluída: ${found.length} vagas encontradas, ${added} novas, ${drafted} com rascunho de IA${retried ? `, ${retried} rascunho(s) pendente(s) recuperado(s)` : ''}.`);
    return { found: found.length, added, drafted, retried };
  } finally {
    scanning = false;
  }
}

module.exports = { scanAndDraft };
