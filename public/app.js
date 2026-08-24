const state = { jobs: [], activeJobId: null };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

// --- Lock screen -----------------------------------------------------------

async function checkStatus() {
  const status = await api('/status');
  if (!status.unlocked) {
    document.getElementById('lockScreen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('lockSubtitle').textContent = status.initialized
      ? 'Digite a senha mestra para desbloquear o cofre de credenciais.'
      : 'Primeiro acesso: crie uma senha mestra para proteger suas credenciais localmente.';
    return false;
  }
  document.getElementById('lockScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  return true;
}

document.getElementById('lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('lockPassword').value;
  const errorEl = document.getElementById('lockError');
  errorEl.textContent = '';
  try {
    const status = await api('/status');
    await api(status.initialized ? '/unlock' : '/setup', {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    document.getElementById('lockPassword').value = '';
    await boot();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('lockBtn').addEventListener('click', async () => {
  await api('/lock', { method: 'POST' });
  await checkStatus();
});

// --- Jobs board --------------------------------------------------------------

async function loadJobs() {
  state.jobs = await api('/jobs');
  render();
}

function render() {
  const columns = ['new', 'drafted', 'sent', 'responded', 'skipped'];
  for (const status of columns) {
    const list = state.jobs.filter((j) =>
      status === 'skipped' ? j.status === 'skipped' || j.status === 'failed' : j.status === status
    );
    document.getElementById(`count-${status}`).textContent = list.length;
    const container = document.getElementById(`cards-${status}`);
    container.innerHTML = '';
    for (const job of list) {
      const el = document.createElement('div');
      el.className = 'job-card' + (status === 'responded' ? ' has-response' : '');
      el.innerHTML = `
        <div class="title">${escapeHtml(job.title || '(sem título)')}${status === 'responded' ? '<span class="badge-new">novo</span>' : ''}</div>
        <div class="meta">${escapeHtml(job.budget || '')} · ${job.bids_count ?? 0} propostas · ${escapeHtml(job.country || '')}</div>
      `;
      el.addEventListener('click', () => openJobModal(job.id));
      container.appendChild(el);
    }
  }
}

document.getElementById('checkResponsesBtn').addEventListener('click', async () => {
  const btn = document.getElementById('checkResponsesBtn');
  btn.disabled = true;
  btn.textContent = 'Verificando...';
  try {
    await api('/jobs/check-responses', { method: 'POST' });
    setTimeout(async () => {
      await loadJobs();
      btn.disabled = false;
      btn.textContent = 'Verificar respostas';
    }, 6000);
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = 'Verificar respostas';
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('scanNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('scanNowBtn');
  btn.disabled = true;
  btn.textContent = 'Buscando...';
  try {
    await api('/jobs/scan', { method: 'POST' });
    setTimeout(async () => {
      await loadJobs();
      btn.disabled = false;
      btn.textContent = 'Buscar vagas agora';
    }, 8000);
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = 'Buscar vagas agora';
  }
});

// --- Job modal ---------------------------------------------------------------

const PROJECT_STATUS_LABELS = {
  evaluating: 'Avaliando propostas',
  awaiting_deposit: 'Aguardando depósito em garantia',
  working: 'Trabalhando',
  finished: 'Finalizado',
  cancelled: 'Cancelado'
};

function openJobModal(id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;
  state.activeJobId = id;
  document.getElementById('jobTitle').textContent = job.title || '';
  const deadlinePart = job.deadline ? ` · prazo: ${job.deadline}` : '';
  document.getElementById('jobMeta').textContent = `${job.budget || 'orçamento não informado'} · ${job.country || ''} · publicado ${job.published_at || ''} · ${job.bids_count ?? 0} propostas · ${(job.skills || []).join(', ')}${deadlinePart}`;
  document.getElementById('jobDescription').textContent = job.description || '';
  document.getElementById('jobDraft').value = job.draft_text || '';
  document.getElementById('jobBudget').value = '';
  document.getElementById('jobDeliveryDays').value = '';
  document.getElementById('jobModalError').textContent = '';

  const conversationBox = document.getElementById('jobConversation');
  if (job.status === 'sent' || job.status === 'responded' || job.page_snapshot) {
    conversationBox.classList.remove('hidden');
    document.getElementById('jobProjectStatus').textContent = job.project_status
      ? `Status no Workana: ${PROJECT_STATUS_LABELS[job.project_status] || job.project_status}`
      : 'Status no Workana: ainda não identificado.';
    document.getElementById('jobConversationTime').textContent = job.last_checked_at
      ? `(última checagem: ${new Date(job.last_checked_at).toLocaleString('pt-BR')})`
      : '';
    document.getElementById('jobConversationText').textContent = job.page_snapshot || '(sem dados capturados ainda)';
    document.getElementById('jobOpenLink').href = job.url;
  } else {
    conversationBox.classList.add('hidden');
  }

  const alreadySent = job.status === 'sent' || job.status === 'responded';
  document.getElementById('jobModalActions').classList.toggle('hidden', alreadySent);
  document.getElementById('jobDraft').readOnly = alreadySent;

  document.getElementById('jobModal').classList.remove('hidden');
}

document.getElementById('closeJobModal').addEventListener('click', () => {
  document.getElementById('jobModal').classList.add('hidden');
});

document.getElementById('regenerateBtn').addEventListener('click', async () => {
  const id = state.activeJobId;
  const errorEl = document.getElementById('jobModalError');
  errorEl.textContent = 'Gerando...';
  try {
    const job = await api(`/jobs/${id}/draft`, { method: 'POST' });
    document.getElementById('jobDraft').value = job.draft_text || '';
    errorEl.textContent = '';
    await loadJobs();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('saveDraftBtn').addEventListener('click', async () => {
  const id = state.activeJobId;
  const draft_text = document.getElementById('jobDraft').value;
  try {
    await api(`/jobs/${id}`, { method: 'PUT', body: JSON.stringify({ draft_text }) });
    await loadJobs();
    document.getElementById('jobModalError').textContent = 'Salvo.';
  } catch (err) {
    document.getElementById('jobModalError').textContent = err.message;
  }
});

document.getElementById('skipBtn').addEventListener('click', async () => {
  const id = state.activeJobId;
  await api(`/jobs/${id}/skip`, { method: 'POST' });
  document.getElementById('jobModal').classList.add('hidden');
  await loadJobs();
});

document.getElementById('sendBtn').addEventListener('click', async () => {
  const id = state.activeJobId;
  const draft_text = document.getElementById('jobDraft').value;
  const budget = document.getElementById('jobBudget').value || undefined;
  const deliveryDays = document.getElementById('jobDeliveryDays').value || undefined;
  const errorEl = document.getElementById('jobModalError');
  errorEl.textContent = 'Enviando (isso abre um navegador em segundo plano, pode levar alguns segundos)...';
  try {
    await api(`/jobs/${id}`, { method: 'PUT', body: JSON.stringify({ draft_text }) });
    await api(`/jobs/${id}/send`, { method: 'POST', body: JSON.stringify({ budget, deliveryDays }) });
    document.getElementById('jobModal').classList.add('hidden');
    await loadJobs();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// --- Settings modal ------------------------------------------------------------

document.getElementById('settingsBtn').addEventListener('click', async () => {
  try {
    const s = await api('/settings');
    document.getElementById('profileBio').value = s.profileBio || '';
    document.getElementById('keywords').value = (s.keywords || []).join(', ');
    document.getElementById('category').value = s.category || 'it-programming';
    document.getElementById('language').value = s.language || 'pt';
    document.getElementById('minBudgetUsd').value = s.minBudgetUsd || 0;
    document.getElementById('scanIntervalMinutes').value = s.scanIntervalMinutes || 30;
    document.getElementById('aiProvider').value = s.aiProvider || 'gemini';
    document.getElementById('aiModel').value = s.aiModel || 'gemini-flash-latest';
    document.getElementById('workanaCredsStatus').textContent =
      s.hasWorkanaEmail && s.hasWorkanaPassword ? 'Credenciais do Workana já configuradas.' : 'Credenciais do Workana ainda não configuradas.';
    document.getElementById('aiKeyStatus').textContent = s.hasAiApiKey ? 'Chave de IA já configurada.' : 'Chave de IA ainda não configurada.';
    document.getElementById('workanaEmail').value = '';
    document.getElementById('workanaPassword').value = '';
    document.getElementById('aiApiKey').value = '';
    document.getElementById('settingsError').textContent = '';
    document.getElementById('settingsSaved').textContent = '';
    document.getElementById('settingsModal').classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('closeSettingsModal').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.add('hidden');
});

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    profileBio: document.getElementById('profileBio').value,
    keywords: document.getElementById('keywords').value.split(',').map((s) => s.trim()).filter(Boolean),
    category: document.getElementById('category').value,
    language: document.getElementById('language').value,
    minBudgetUsd: Number(document.getElementById('minBudgetUsd').value) || 0,
    scanIntervalMinutes: Number(document.getElementById('scanIntervalMinutes').value) || 30,
    aiProvider: document.getElementById('aiProvider').value,
    aiModel: document.getElementById('aiModel').value,
    workanaEmail: document.getElementById('workanaEmail').value,
    workanaPassword: document.getElementById('workanaPassword').value,
    aiApiKey: document.getElementById('aiApiKey').value
  };
  try {
    await api('/settings', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('settingsSaved').textContent = 'Configurações salvas.';
    document.getElementById('settingsError').textContent = '';
  } catch (err) {
    document.getElementById('settingsError').textContent = err.message;
  }
});

// --- Logs modal ------------------------------------------------------------

document.getElementById('logsBtn').addEventListener('click', async () => {
  const logs = await api('/logs');
  const el = document.getElementById('logsList');
  el.innerHTML = logs
    .map((l) => `<div class="log-line log-${l.level}">[${new Date(l.created_at).toLocaleString('pt-BR')}] ${escapeHtml(l.message)}</div>`)
    .join('');
  document.getElementById('logsModal').classList.remove('hidden');
});

document.getElementById('closeLogsModal').addEventListener('click', () => {
  document.getElementById('logsModal').classList.add('hidden');
});

// --- Boot ------------------------------------------------------------------

async function boot() {
  const unlocked = await checkStatus();
  if (unlocked) await loadJobs();
}

boot();
setInterval(async () => {
  if (!document.getElementById('app').classList.contains('hidden')) {
    await loadJobs().catch(() => {});
  }
}, 20000);
