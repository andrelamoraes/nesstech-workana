// Never touch the real ./data — every test run gets a throwaway directory.
process.env.WORKANA_DATA_DIR = require('path').join(require('os').tmpdir(), 'workana-wa-test-' + process.pid);
process.env.WAHA_URL = 'http://waha.test:3000';
process.env.WAHA_API_KEY = 'chave-teste';
process.env.WAHA_SESSION = 'default';

// WhatsApp alerts with WAHA (global fetch) and the AI scorer replaced by stubs.
const assert = require('assert');
const path = require('path');

const resolve = (p) => require.resolve(path.join(__dirname, '..', 'server', p));

let nextScore = 90;
const scoreCalls = [];
require.cache[resolve('services/aiProposal')] = {
  id: resolve('services/aiProposal'),
  loaded: true,
  exports: {
    scoreJob: async ({ job }) => {
      scoreCalls.push(job.id);
      return nextScore === null ? null : { score: nextScore, fit: 'ok', risks: [], recommend: true };
    },
    generateProposal: async () => ({ text: 'x', modelUsed: 'stub' })
  }
};

require.cache[resolve('vault')] = {
  id: resolve('vault'),
  loaded: true,
  exports: {
    isUnlocked: () => true,
    decrypt: (blob) => (blob ? 'valor-decriptado' : null),
    encrypt: (v) => v,
    isInitialized: () => true
  }
};

// --- fake WAHA ------------------------------------------------------------------

const sent = []; // { chatId, text, session, apiKey }
let failFor = new Set(); // chatIds whose sendText returns 500
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  assert.strictEqual(u.origin, 'http://waha.test:3000');
  if (u.pathname === '/api/contacts/check-exists') {
    const phone = u.searchParams.get('phone');
    // Emulates an old BR account living under the 8-digit ID.
    if (phone === '5511997135040') return json(200, { numberExists: true, chatId: '551197135040@c.us' });
    return json(200, { numberExists: true, chatId: `${phone}@c.us` });
  }
  if (u.pathname === '/api/sendText') {
    const body = JSON.parse(opts.body);
    if (failFor.has(body.chatId)) return json(500, { error: 'boom' });
    sent.push({ ...body, apiKey: opts.headers['X-Api-Key'] });
    return json(201, { id: 'msg' });
  }
  return json(404, {});
};

const db = require(resolve('db'));
const notifier = require(resolve('services/opportunityNotifier'));
notifier._timing.gapMs = () => 0;

const NUMBERS = ['5511997135040', '5521992015506'];

function seed(jobs, wa = {}) {
  const state = db.load();
  state.jobs = jobs;
  state.settings.aiApiKeyEnc = 'enc';
  state.settings.whatsapp = { enabled: true, recipients: NUMBERS, minScore: 70, ...wa };
  sent.length = 0;
  scoreCalls.length = 0;
  failFor = new Set();
  return state;
}

const job = (over = {}) => ({
  id: 1,
  title: 'Automação com Node',
  url: 'https://www.workana.com/job/automacao-com-node',
  description: 'descricao',
  skills: [],
  budget: 'USD 250 - 500',
  bids_count: 4,
  status: 'drafted',
  created_at: new Date().toISOString(),
  ...over
});

(async () => {
  nextScore = 90;

  {
    const state = seed([job()]);
    const o = await notifier.notifyNewOpportunities();
    assert.strictEqual(o.notified, 1);
    assert.strictEqual(sent.length, 2, 'um envio por número');
    assert.deepStrictEqual(sent.map((s) => s.chatId), ['551197135040@c.us', '5521992015506@c.us'], 'usa o chatId devolvido pelo WAHA');
    assert.ok(sent.every((s) => s.apiKey === 'chave-teste' && s.session === 'default'));
    const text = sent[0].text;
    assert.ok(text.includes('Automação com Node'), 'título');
    assert.ok(text.includes('USD 250 - 500'), 'faixa de pagamento');
    assert.ok(text.includes('https://www.workana.com/job/automacao-com-node'), 'link');
    assert.ok(state.jobs[0].whatsapp_notified_at);
    console.log('  ok avisa boa oportunidade nos dois números (título, faixa, link)');

    await notifier.notifyNewOpportunities();
    assert.strictEqual(sent.length, 2, 'não reenviou');
    console.log('  ok não avisa a mesma vaga duas vezes');
  }

  {
    nextScore = 40;
    const state = seed([job()]);
    await notifier.notifyNewOpportunities();
    assert.strictEqual(sent.length, 0);
    assert.match(state.jobs[0].whatsapp_skip, /score 40/);
    console.log('  ok não avisa vaga com score abaixo do mínimo');
    nextScore = 90;
  }

  {
    seed([job({ auto_score: { score: 85 } })]);
    await notifier.notifyNewOpportunities();
    assert.strictEqual(scoreCalls.length, 0, 'reaproveita o score já calculado');
    assert.strictEqual(sent.length, 2);
    console.log('  ok reaproveita auto_score existente');
  }

  {
    seed([
      job({ id: 1, created_at: new Date(Date.now() - 48 * 3600e3).toISOString() }),
      job({ id: 2, status: 'sent' }),
      job({ id: 3, status: 'skipped' })
    ]);
    await notifier.notifyNewOpportunities();
    assert.strictEqual(sent.length, 0);
    console.log('  ok ignora vaga antiga, já enviada ou ignorada');
  }

  {
    const state = seed([job()]);
    failFor = new Set(['5521992015506@c.us']);
    await notifier.notifyNewOpportunities();
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(state.jobs[0].whatsapp_sent_to, ['5511997135040']);
    assert.strictEqual(state.jobs[0].whatsapp_attempts, 1);
    assert.ok(!state.jobs[0].whatsapp_notified_at);

    failFor = new Set();
    await notifier.notifyNewOpportunities();
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].chatId, '5521992015506@c.us', 'só reenviou pra quem faltou');
    assert.ok(state.jobs[0].whatsapp_notified_at);
    console.log('  ok falha parcial só reenvia para o número que faltou');
  }

  {
    seed([job()], { enabled: false });
    const o = await notifier.notifyNewOpportunities();
    assert.strictEqual(o.skipped, 'disabled');
    assert.strictEqual(sent.length, 0);
    console.log('  ok desligado não envia nada');
  }

  {
    nextScore = null;
    const state = seed([job()]);
    for (let i = 0; i < 5; i++) await notifier.notifyNewOpportunities();
    assert.strictEqual(scoreCalls.length, 3, 'desiste depois de 3 tentativas de pontuar');
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(state.jobs[0].whatsapp_attempts, 3);
    console.log('  ok sem score da IA não avisa e desiste após 3 tentativas');
    nextScore = 90;
  }

  console.log('whatsapp: todos os testes passaram');
  require('fs').rmSync(process.env.WORKANA_DATA_DIR, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
