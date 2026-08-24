const cron = require('node-cron');
const db = require('../db');
const vault = require('../vault');
const logger = require('./logger');
const { scanAndDraft } = require('./scanAndDraft');
const { checkResponses } = require('./workanaResponses');

let task = null;
let currentIntervalMinutes = null;

function scheduleFromSettings() {
  const { scanIntervalMinutes } = db.load().settings;
  const minutes = Math.max(5, Number(scanIntervalMinutes) || 30);

  if (task && minutes === currentIntervalMinutes) return;
  if (task) task.stop();

  currentIntervalMinutes = minutes;
  const cronExpr = `*/${minutes} * * * *`;
  task = cron.schedule(cronExpr, async () => {
    if (!vault.isUnlocked()) return; // nothing to do while locked
    try {
      await scanAndDraft();
    } catch (err) {
      logger.error(`Erro na varredura agendada: ${err.message}`);
    }
    try {
      const { settings, jobs } = db.load();
      const email = vault.decrypt(settings.workanaEmailEnc);
      const password = vault.decrypt(settings.workanaPasswordEnc);
      if (email && password) {
        const result = await checkResponses(email, password, jobs);
        db.save();
        if (result.checked) {
          logger.info(`Checagem de respostas: ${result.checked} vaga(s), ${result.newResponses} com atividade nova.`);
        }
      }
    } catch (err) {
      logger.error(`Erro na checagem agendada de respostas: ${err.message}`);
    }
  });
  logger.info(`Agendador configurado para rodar a cada ${minutes} minuto(s). Busca vagas, rascunha com IA e confere respostas — nunca envia nada sozinho.`);
}

module.exports = { scheduleFromSettings };
