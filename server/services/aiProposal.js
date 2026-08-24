const logger = require('./logger');

// Google keeps retiring Gemini model IDs from under us (gemini-2.0-flash,
// then gemini-2.5-flash, both cut off within weeks of each other) — even
// their own "latest" alias isn't safe for every key. So instead of trusting
// any single hardcoded name, this asks the API directly which models the
// current key can actually use, and picks a sensible one automatically.
const DEFAULT_MODEL = 'gemini-flash-latest';

function buildPrompt(job, profileBio) {
  return `Você é um freelancer brasileiro sênior respondendo a um projeto técnico no Workana. O cliente já recebeu dezenas de propostas genéricas hoje — a sua só vale a pena se provar, de forma concreta, que você entendeu os pontos difíceis do projeto. Ninguém lê elogio vazio sobre a própria ideia dele.

REGRAS DURAS — a proposta é inútil se violar qualquer uma:
- PROIBIDO abrir com saudação ou elogio genérico ("Olá! Li atentamente os requisitos...", "Achei excelente a iniciativa", "Projeto muito interessante"). Comece direto em um ponto técnico específico do projeto.
- PROIBIDO frases de vendedor vazias ("tenho vasta experiência", "conte comigo", "estou à disposição", "será um prazer").
- Cite pelo menos 2 detalhes CONCRETOS da descrição (números, nomes de requisitos, restrições específicas) — não paráfrase genérica do que é o projeto.
- Identifique o ponto mais crítico/arriscado do projeto e dê uma opinião técnica real sobre como você resolveria — não basta descrever o problema de volta pro cliente, tem que mostrar uma direção de solução.

Sobre o freelancer (base para a proposta, não copiar literalmente):
${profileBio || '(nenhum perfil configurado ainda — escreva algo genérico pedindo pra revisar, mas mantenha o resto das regras)'}

Vaga:
Título: ${job.title}
Descrição completa: ${job.description}
Habilidades pedidas: ${(job.skills || []).join(', ')}
Orçamento informado: ${job.budget || 'não informado'}
${job.deadline ? `Prazo mencionado pelo cliente: ${job.deadline}` : ''}

Estrutura (4 a 6 parágrafos curtos):
1. Abra direto no ponto técnico mais crítico/arriscado que você identificou no projeto — sem saudação, sem elogio.
2. Dê sua abordagem técnica concreta para esse ponto (uma direção real, não genérica).
3. Conecte com mais 1-2 requisitos específicos citados na descrição, provando domínio do escopo.
4. Relacione com a experiência do freelancer, só onde for genuinamente relevante.
5. Feche com um próximo passo objetivo e específico a ESTE projeto (ex: pedir acesso a algo mencionado na descrição, propor uma call sobre um ponto específico do escopo) — nunca um fechamento genérico.
Não invente números de orçamento nem prazo — deixe esses campos para o freelancer preencher separadamente.
Responda só com o texto da proposta, direto no primeiro parágrafo técnico, sem saudação inicial e sem explicações antes ou depois.`;
}

async function listAvailableModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Não consegui listar os modelos disponíveis (${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.models || [];
}

// Prefer a Flash model (cheap/fast, fits a free-tier key) that this specific
// key can call. Ranks Google's own "-latest" alias first, then falls back to
// whatever Flash variant with generateContent support it finds.
function pickBestFlashModel(models) {
  const usable = models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'));
  const flash = usable.filter((m) => /flash/i.test(m.name) && !/vision|embedding|tts|image/i.test(m.name));
  const pool = flash.length ? flash : usable;
  if (!pool.length) return null;

  const alias = pool.find((m) => /latest/i.test(m.name));
  if (alias) return alias.name.replace(/^models\//, '');

  pool.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  return pool[0].name.replace(/^models\//, '');
}

const DEFAULT_MAX_TOKENS = 1536;

async function callGemini(apiKey, modelId, prompt, maxOutputTokens = DEFAULT_MAX_TOKENS) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.75, maxOutputTokens }
    })
  });
}

// 429 (rate limit) and 503 (overloaded) are Google telling us to just try
// again — not a config problem, so they shouldn't reach the user as an error.
const RETRYABLE_STATUSES = new Set([429, 500, 503]);
const MAX_ATTEMPTS = 4;

async function callGeminiWithRetry(apiKey, modelId, prompt, maxOutputTokens) {
  let resp;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    resp = await callGemini(apiKey, modelId, prompt, maxOutputTokens);
    if (resp.ok || !RETRYABLE_STATUSES.has(resp.status) || attempt === MAX_ATTEMPTS) return resp;
    const waitMs = 1500 * 2 ** (attempt - 1); // 1.5s, 3s, 6s
    logger.warn(`Gemini retornou ${resp.status} (sobrecarga temporária) — tentando de novo em ${Math.round(waitMs / 1000)}s (tentativa ${attempt}/${MAX_ATTEMPTS})...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return resp;
}

function extractText(data) {
  return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('').trim();
}

function finishReason(data) {
  return data?.candidates?.[0]?.finishReason;
}

// Returns { text, modelUsed } — modelUsed lets the caller remember whatever
// model actually worked, so next time we skip straight to it instead of
// hitting the same dead model again.
async function generateProposal({ apiKey, job, profileBio, model }) {
  if (!apiKey) throw new Error('Chave de IA não configurada.');

  const prompt = buildPrompt(job, profileBio);
  let modelId = model || DEFAULT_MODEL;

  let resp = await callGeminiWithRetry(apiKey, modelId, prompt);

  if (resp.status === 404) {
    logger.warn(`Modelo "${modelId}" indisponível para esta chave — procurando um modelo compatível automaticamente...`);
    try {
      const models = await listAvailableModels(apiKey);
      const fallback = pickBestFlashModel(models);
      if (fallback && fallback !== modelId) {
        modelId = fallback;
        resp = await callGeminiWithRetry(apiKey, modelId, prompt);
        if (resp.ok) {
          logger.info(`Modelo "${modelId}" funcionou — vou usar ele daqui pra frente.`);
        }
      }
    } catch (err) {
      logger.error(`Falha ao buscar modelos disponíveis: ${err.message}`);
    }
  }

  if (!resp.ok) {
    if (resp.status === 503 || resp.status === 429) {
      throw new Error(`A Gemini API está sobrecarregada no momento — já tentei de novo ${MAX_ATTEMPTS} vezes automaticamente e não consegui. Isso não é um problema de configuração, é instabilidade do lado do Google; essa vaga vai ser tentada de novo sozinha na próxima varredura, ou clique em "Gerar novo rascunho" daqui a alguns minutos.`);
    }
    const errText = await resp.text().catch(() => '');
    const hint = resp.status === 404
      ? ' — não encontrei nenhum modelo Flash disponível para essa chave. Confira se a chave está certa em https://aistudio.google.com/app/apikey.'
      : '';
    throw new Error(`Gemini API retornou ${resp.status}: ${errText.slice(0, 300)}${hint}`);
  }

  let data = await resp.json();
  let text = extractText(data);

  // The proposal got cut off mid-sentence because it hit the token cap, not
  // because it was actually done — give it one shot with a lot more room
  // instead of handing back a truncated draft.
  if (finishReason(data) === 'MAX_TOKENS') {
    logger.warn(`Rascunho cortado por limite de tokens para "${job.title}" — tentando de novo com mais espaço...`);
    const retryResp = await callGeminiWithRetry(apiKey, modelId, prompt, DEFAULT_MAX_TOKENS * 2);
    if (retryResp.ok) {
      const retryData = await retryResp.json();
      const retryText = extractText(retryData);
      if (retryText) {
        data = retryData;
        text = retryText;
        if (finishReason(data) === 'MAX_TOKENS') {
          logger.warn(`Rascunho de "${job.title}" ainda cortado mesmo com o dobro de tokens — pode precisar de edição manual.`);
        }
      }
    }
  }

  if (!text) {
    logger.warn('Gemini retornou resposta vazia para uma vaga.');
  }
  return { text, modelUsed: modelId };
}

module.exports = { generateProposal, listAvailableModels, pickBestFlashModel };
