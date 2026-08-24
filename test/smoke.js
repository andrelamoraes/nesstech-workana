// Never touch the real ./data — every test run gets a throwaway directory.
process.env.WORKANA_DATA_DIR = require('path').join(require('os').tmpdir(), 'workana-test-' + process.pid);

// Loads every module and exercises the pure logic of the auto-send engine.
const assert = require('assert');

const mods = [
  '../server/db',
  '../server/vault',
  '../server/services/logger',
  '../server/services/pageState',
  '../server/services/browserManager',
  '../server/services/workanaAuth',
  '../server/services/workanaResponses',
  '../server/services/workanaSubmit',
  '../server/services/workanaScraper',
  '../server/services/selectorProbe',
  '../server/services/aiProposal',
  '../server/services/autoSend',
  '../server/services/scanAndDraft',
  '../server/services/scheduler',
  '../server/routes/auth',
  '../server/routes/settings',
  '../server/routes/jobs'
];
for (const m of mods) {
  require(m);
  console.log('  ok', m);
}

const { parseBudgetRange, resolveBudget } = require('../server/services/autoSend');

const cases = [
  ['USD 100 - 250', { min: 100, max: 250 }],
  ['USD 750', { min: 750, max: 750 }],
  ['Menos de USD 100', { min: null, max: 100 }],
  ['Mais de USD 5.000', { min: 5000, max: null }],
  ['Más de USD 1.500', { min: 1500, max: null }],
  [null, { min: null, max: null }],
  ['a combinar', { min: null, max: null }]
];
for (const [input, expected] of cases) {
  const got = parseBudgetRange(input);
  assert.deepStrictEqual(got, expected, `parseBudgetRange(${input}) => ${JSON.stringify(got)}`);
  console.log('  ok budget', JSON.stringify(input), '->', JSON.stringify(got));
}

const job = { budget: 'USD 200 - 600' };
assert.strictEqual(resolveBudget(job, { budgetStrategy: 'job_min' }), 200);
assert.strictEqual(resolveBudget(job, { budgetStrategy: 'job_max' }), 600);
assert.strictEqual(resolveBudget(job, { budgetStrategy: 'job_mid' }), 400);
assert.strictEqual(resolveBudget(job, { budgetStrategy: 'fixed', fixedBudget: 999 }), 999);
assert.strictEqual(resolveBudget({ budget: 'a combinar' }, { budgetStrategy: 'job_min', fixedBudget: 0 }), null,
  'orcamento ilegivel sem valor fixo deve virar null (o motor pula a vaga)');
console.log('  ok resolveBudget');

// The status snapshot must work on a fresh db with no autoSendState yet.
const autoSend = require('../server/services/autoSend');
const snap = autoSend.statusSnapshot();
assert.strictEqual(snap.enabled, false, 'auto-send deve vir DESLIGADO por padrao');
assert.strictEqual(snap.effectiveDryRun, true, 'sem armar, tudo deve ser dry-run');
console.log('  ok statusSnapshot', JSON.stringify(snap));

// Disabled must short-circuit before touching the browser or credentials.
autoSend.runAutoSend().then((r) => {
  assert.strictEqual(r.skipped, 'disabled');
  console.log('  ok runAutoSend curto-circuita quando desligado:', JSON.stringify(r));
  console.log('\nTUDO OK');
  process.exit(0);
});
