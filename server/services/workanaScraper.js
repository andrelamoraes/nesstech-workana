const logger = require('./logger');
const browserManager = require('./browserManager');

function buildUrl({ language, category, page }) {
  const params = new URLSearchParams();
  if (language) params.set('language', language);
  if (category) params.set('category', category);
  if (page && page > 1) params.set('page', String(page));
  return `https://www.workana.com/jobs?${params.toString()}`;
}

function slugFromHref(href) {
  const match = href.match(/\/job\/([^/?#]+)/);
  return match ? match[1] : href;
}

// The listing card's textContent drags in the sibling "Ver más detalles" /
// "leer más" link label, and Workana's expander widget leaves its own
// "leer más"/"retraer" toggle text glued onto the real description text.
// Strip those out wherever a description string gets built.
function cleanDescription(text) {
  if (!text) return text;
  return text
    .replace(/\s*(Ver más detalles|Ver mais detalhes|leer más|ler mais|retraer|recolher)\s*$/i, '')
    .trim();
}

async function scrapePage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Workana runs a Cloudflare bot-check interstitial before the real page loads.
  await page.waitForSelector('.project-item', { timeout: 25000 }).catch(() => {});

  return page.$$eval('.project-item', (cards) =>
    cards.map((card) => {
      const titleLink = card.querySelector('.project-title a');
      const desc = card.querySelector('.project-details .text-expander-content');
      const skills = Array.from(card.querySelectorAll('.skills a.skill h3')).map((s) => s.textContent.trim());
      const date = card.querySelector('.project-main-details .date');
      const bids = card.querySelector('.project-main-details .bids');
      const countryLink = card.querySelector('.project-author .country a');
      const budget = card.querySelector('.budget .values span');

      return {
        title: titleLink ? titleLink.textContent.trim() : null,
        href: titleLink ? titleLink.getAttribute('href') : null,
        description: desc ? desc.textContent.replace(/\s+/g, ' ').trim() : '',
        skills,
        publishedAt: date ? date.textContent.replace('Publicado:', '').trim() : null,
        bidsCount: bids ? parseInt((bids.textContent.match(/\d+/) || ['0'])[0], 10) : 0,
        country: countryLink ? countryLink.getAttribute('href').replace('/jobs?country=', '') : null,
        budget: budget ? budget.textContent.trim() : null
      };
    })
  );
}

async function scanJobs({ language = 'pt', category = '', maxPages = 2 } = {}) {
  const results = [];
  const context = await browserManager.newContext();
  try {
    const page = await context.newPage();
    for (let p = 1; p <= maxPages; p++) {
      const url = buildUrl({ language, category, page: p });
      logger.info(`Buscando vagas: ${url}`);
      const items = await scrapePage(page, url);
      if (items.length === 0) break;
      for (const item of items) {
        if (!item.href) continue;
        results.push({
          slug: slugFromHref(item.href),
          url: `https://www.workana.com${item.href}`,
          title: item.title,
          description: cleanDescription(item.description),
          skills: item.skills,
          publishedAt: item.publishedAt,
          bidsCount: item.bidsCount,
          country: item.country,
          budget: item.budget
        });
      }
      await browserManager.jitter(800, 1800);
    }
  } finally {
    await context.close();
  }
  return results;
}

async function extractDetailPage(page) {
  return page.evaluate(() => {
    const expander = document.querySelector('.expander');
    // Fallback for the rare case the expander widget isn't there (very short
    // descriptions, or a markup variant): pull the "Sobre este proyecto"
    // block from the article and strip the chrome around it as best we can.
    let fallbackText = null;
    if (!expander) {
      const article = document.querySelector('article');
      if (article) {
        fallbackText = article.innerText
          .split(/\n\s*Categoría\b|\n\s*Categoria\b|\n\s*Habilidades necesarias\b|\n\s*Habilidades necessárias\b/i)[0]
          .replace(/^Sobre este proyecto\s*\n?/i, '')
          .replace(/^(Abierto|Cerrado|Aberto|Fechado)\s*\n?/i, '')
          .trim();
      }
    }
    const deadlineLabel = Array.from(document.querySelectorAll('p')).find((p) =>
      /plazo de entrega|prazo de entrega/i.test(p.textContent)
    );
    return {
      description: expander ? expander.innerText.trim() : fallbackText,
      deadline: deadlineLabel
        ? deadlineLabel.textContent.replace(/plazo de entrega:?|prazo de entrega:?/i, '').trim()
        : null
    };
  });
}

// The listing page only ships a preview (server-truncated, "Ver más
// detalles" opens the real page) — this fetches the full text from the job's
// own page. Called per new/matching job, not for every card in the listing,
// to avoid extra requests on jobs we're going to skip anyway.
async function fetchFullDescription(url) {
  const context = await browserManager.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.expander, article', { timeout: 25000 }).catch(() => {});

    let data = await extractDetailPage(page);

    // One retry: the Cloudflare interstitial occasionally resolves slower
    // than our wait, leaving the page half-rendered on the first pass.
    if (!data.description) {
      logger.warn(`Descrição vazia na primeira tentativa para ${url}, tentando de novo...`);
      await browserManager.jitter(1000, 2000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.expander, article', { timeout: 25000 }).catch(() => {});
      data = await extractDetailPage(page);
    }

    await browserManager.jitter(400, 900);
    return { description: cleanDescription(data.description), deadline: data.deadline };
  } finally {
    await context.close();
  }
}

module.exports = { scanJobs, fetchFullDescription };
