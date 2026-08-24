const db = require('../db');

function log(level, message) {
  const state = db.load();
  state.logs.unshift({ level, message, created_at: new Date().toISOString() });
  state.logs = state.logs.slice(0, 300);
  db.save();
  const line = `[${level.toUpperCase()}] ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = {
  info: (msg) => log('info', msg),
  warn: (msg) => log('warn', msg),
  error: (msg) => log('error', msg),
  recent: (limit = 100) => db.load().logs.slice(0, limit)
};
