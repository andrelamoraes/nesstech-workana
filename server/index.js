const express = require('express');
const path = require('path');
const logger = require('./services/logger');
const browserManager = require('./services/browserManager');

const app = express();
const PORT = process.env.PORT || 4173;
const HOST = '127.0.0.1'; // local only, on purpose — this app is never meant to face the network

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', require('./routes/auth'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/jobs', require('./routes/jobs'));

app.get('/api/logs', (req, res) => {
  res.json(logger.recent(150));
});

const server = app.listen(PORT, HOST, () => {
  logger.info(`Painel disponível em http://${HOST}:${PORT}`);
});

async function shutdown() {
  logger.info('Encerrando...');
  await browserManager.shutdown();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
