// Never touch the real ./data — every test run gets a throwaway directory.
process.env.WORKANA_DATA_DIR = require('path').join(require('os').tmpdir(), 'workana-test-' + process.pid);

// Exercises the decision pipeline of the automatic queue WITHOUT a browser or
// a real Gemini key: the modules that touch the outside world are replaced in
// require.cache before autoSend is loaded.
//
// This is the code that decides to spend a proposal credit, so the cases below
// are all "did it correctly refuse to send?".
const assert = require('assert');
const path = require('path');

const resolve = (p) => require.resolve(path.join(__dirname, '..', 'server', p));

// --- stubs (installed before autoSend is required) ---------------------------

const submitCalls = [];
require.cache[resolve('services/workanaSubmit')] = {
  id: resolve('services/workanaSubmit'),
  loaded: true,
  exports: {
    submitProposal: async (email, password, job, opts) => {
      submitCalls.push({ jobId: job.id, ...opts });
      return opts.dryRun
        ? { dryRun: true, verified: false, diagPath: '/fake/diag' }
        : {
            dryRun: false,
            verified: true,
            evidence: 'proposta enviada',
            hash: 'h',
            snapshot: 's',
            projectStatus: 'evaluating',
            checkedAt: new Date().toISOString()
          };
    },
    inspectJobPage: async () => ({}),
    SubmitError: class SubmitError extends Error {}
  }
};

const scoreCalls = [];
let nextScore = 90;
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

// No real waiting between sends.
const bm = require(resolve('services/browserManager'));
bm.jitter = async () => {};

const db = require(resolve('db'));
const autoSend = require(resolve('services/autoSend'));

// --- fixtures -----------------------------------------------------------------

function seed(jobs, autoCfg = {}) {
  const state = db.load();
  state.jobs = jobs;
  state.autoSendState = null;
  state.settings.workanaEmailEnc = 'enc';
  state.settings.workanaPasswordEnc = 'enc';
  state.settings.aiApiKeyEnc = 'enc';
  state.settings.autoSend = {
    enabled: true,
    dryRun: false,
    armed: true,
    maxPerDay: 5,
    maxPerCycle: 5,
    minScore: 70,
    minBudgetUsd: 0,
    maxBidsCount: 25,
    blocklist: [],
    budgetStrategy: 'job_min',
    fixedBudget: 0,
    defaultDeliveryDays: 14,
    minDelayBetweenSendsSec: 30,
    ...autoCfg
  };
  submitCalls.length = 0;
  scoreCalls.length = 0;
  return state;
}

const job = (over = {}) => ({
  id: 1,
  title: 'Projeto teste',
  url: 'https://www.workana.com/job/x',
  description: 'descricao',
  skills: [],
  budget: 'USD 300 - 500',
  bids_count: 3,
  status: 'drafted',
  draft_text: 'proposta redigida',
  ...over
});

async function run(label, jobs, cfg, check) {
  const state = seed(jobs, cfg);
  const outcome = await autoSend.runAutoSend();
  check(outcome, state.jobs, submitCalls);
  console.log('  ok', label);
}

// --- cases ---------------------------------------------------------------------

(async () => {
  nextScore = 90;

  await run('envia quando tudo passa', [job()], {}, (o, jobs, calls) => {
    assert.strictEqual(o.sent, 1, 'deveria ter enviado 1');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].dryRun, false);
    assert.strictEqual(calls[0].budget, 300, 'job_min de "USD 300 - 500"');
    assert.strictEqual(calls[0].deliveryDays, 14);
    assert.strictEqual(jobs[0].status, 'sent');
    assert.strictEqual(jobs[0].sent_by, 'auto');
  });

  await run('dry-run NUNCA envia de verdade', [job()], { dryRun: true }, (o, jobs, calls) => {
    assert.strictEqual(o.sent, 0);
    assert.strictEqual(o.wouldSend, 1);
    assert.strictEqual(calls[0].dryRun, true, 'submitProposal precisa receber dryRun=true');
    assert.strictEqual(jobs[0].status, 'drafted', 'dry-run nao pode marcar como enviada');
  });

  await run('sem armar, roda como dry-run mesmo com dryRun=false', [job()], { armed: false }, (o, jobs, calls) => {
    assert.strictEqual(o.sent, 0, 'nao armado nao pode enviar');
    assert.strictEqual(calls[0].dryRun, true);
    assert.strictEqual(jobs[0].status, 'drafted');
  });

  await run('respeita o teto diario', [job({ id: 1 }), job({ id: 2 }), job({ id: 3 })], { maxPerDay: 2 },
    (o, jobs, calls) => {
      assert.strictEqual(o.sent, 2, `esperava 2 envios, veio ${o.sent}`);
      assert.strictEqual(calls.length, 2);
    });

  await run('respeita o teto por ciclo', [job({ id: 1 }), job({ id: 2 }), job({ id: 3 })],
    { maxPerCycle: 1, maxPerDay: 10 }, (o, jobs, calls) => {
      assert.strictEqual(calls.length, 1);
    });

  await run('pula vaga lotada de propostas', [job({ bids_count: 99 })], { maxBidsCount: 25 },
    (o, jobs, calls) => {
      assert.strictEqual(calls.length, 0, 'nao pode nem abrir o navegador');
      assert.strictEqual(o.skipped, 1);
      assert.match(jobs[0].auto_decision.reason, /99 propostas/);
    });

  await run('pula orcamento abaixo do minimo', [job({ budget: 'USD 50 - 80' })], { minBudgetUsd: 200 },
    (o, jobs, calls) => {
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(o.skipped, 1);
    });

  await run('veta por termo da blocklist', [job({ title: 'Preciso de um clone do Uber' })],
    { blocklist: ['clone do'] }, (o, jobs, calls) => {
      assert.strictEqual(calls.length, 0);
      assert.match(jobs[0].auto_decision.reason, /clone do/);
    });

  nextScore = 40;
  await run('pula score baixo', [job()], { minScore: 70 }, (o, jobs, calls) => {
    assert.strictEqual(calls.length, 0, 'score baixo nao pode gastar Conexao');
    assert.match(jobs[0].auto_decision.reason, /score 40/);
  });

  nextScore = null;
  await run('pula quando a IA nao consegue pontuar', [job()], {}, (o, jobs, calls) => {
    assert.strictEqual(calls.length, 0, 'sem score, nao envia');
    assert.strictEqual(jobs[0].auto_decision.retryable, true);
  });

  nextScore = 90;
  await run('pula orcamento ilegivel sem valor fixo', [job({ budget: 'a combinar' })],
    { budgetStrategy: 'job_min', fixedBudget: 0 }, (o, jobs, calls) => {
      assert.strictEqual(calls.length, 0, 'nunca propor valor 0');
      assert.match(jobs[0].auto_decision.reason, /valor de proposta/);
    });

  await run('usa valor fixo quando o orcamento e ilegivel', [job({ budget: 'a combinar' })],
    { budgetStrategy: 'fixed', fixedBudget: 450 }, (o, jobs, calls) => {
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].budget, 450);
    });

  await run('nao toca em vagas que nao estao em "drafted"', [job({ status: 'sent' }), job({ id: 2, status: 'new' })],
    {}, (o, jobs, calls) => {
      assert.strictEqual(calls.length, 0);
    });

  await run('nao envia com rascunho vazio', [job({ draft_text: '   ' })], {}, (o, jobs, calls) => {
    assert.strictEqual(calls.length, 0);
    assert.match(jobs[0].auto_decision.reason, /rascunho vazio/);
  });

  // desligado é o padrão de fábrica e precisa continuar sendo respeitado
  await run('desligado nao faz nada', [job()], { enabled: false }, (o, jobs, calls) => {
    assert.strictEqual(o.skipped, 'disabled');
    assert.strictEqual(calls.length, 0);
  });

  console.log('\nTUDO OK (autosend)');
  process.exit(0);
})().catch((err) => {
  console.error('\nFALHOU:', err.message);
  process.exit(1);
});
