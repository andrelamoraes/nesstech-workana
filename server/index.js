const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('./services/logger');
const browserManager = require('./services/browserManager');
const vault = require('./vault');
const scheduler = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 4173;
// Local only by default, on purpose: once the vault is unlocked the API has no
// login of its own. On a server, reach it through an SSH tunnel
// (ssh -L 4173:127.0.0.1:4173 user@server) instead of opening the port.
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', require('./routes/auth'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/jobs', require('./routes/jobs'));

app.get('/api/logs', (req, res) => {
  res.json(logger.recent(150));
});

// Unattended servers restart (deploys, reboots, crashes) with nobody around to
// type the master password, which would leave the scheduler idle until someone
// logs in. If the password is provided via the environment — ideally through
// WORKANA_MASTER_PASSWORD_FILE pointing at a root-owned 0600 file — unlock at
// boot. Trade-off: whoever can read that file can decrypt db.json.
function autoUnlock() {
  let password = process.env.WORKANA_MASTER_PASSWORD || '';
  const file = process.env.WORKANA_MASTER_PASSWORD_FILE;
  if (!password && file) {
    try {
      password = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      logger.error(`Não consegui ler WORKANA_MASTER_PASSWORD_FILE (${file}): ${err.message}`);
      return;
    }
  }
  if (!password) return;
  if (!vault.isInitialized()) {
    logger.warn('Senha mestra fornecida pelo ambiente, mas o cofre ainda não foi criado — crie pelo painel no primeiro acesso.');
    return;
  }
  try {
    vault.unlock(password);
    scheduler.scheduleFromSettings();
    logger.info('Cofre desbloqueado automaticamente na inicialização.');
  } catch (err) {
    logger.error(`Desbloqueio automático falhou: ${err.message}`);
  }
}

const server = app.listen(PORT, HOST, () => {
  logger.info(`Painel disponível em http://${HOST}:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    logger.warn(`Escutando em ${HOST}: o painel não tem login próprio — não exponha essa porta sem um proxy com autenticação.`);
  }
  autoUnlock();
});

async function shutdown() {
  logger.info('Encerrando...');
  await browserManager.shutdown();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
