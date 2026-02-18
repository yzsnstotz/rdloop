const path = require('path');

module.exports = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  RDLOOP_GUI_BASE_URL: process.env.RDLOOP_GUI_BASE_URL || 'http://localhost:17333',
  RDLOOP_ENABLE_WRITES: process.env.RDLOOP_ENABLE_WRITES === 'true',
  RDLOOP_NOTIFY_RATE_LIMIT: parseInt(process.env.RDLOOP_NOTIFY_RATE_LIMIT || '5', 10),
  RDLOOP_WRITE_RATE_LIMIT: parseInt(process.env.RDLOOP_WRITE_RATE_LIMIT || '10', 10),
  RDLOOP_POLL_INTERVAL: parseInt(process.env.RDLOOP_POLL_INTERVAL || '30000', 10),
  TELEGRAM_CHAT_ALLOWLIST: (process.env.TELEGRAM_CHAT_ALLOWLIST || '').split(',').filter(Boolean),
  OUT_DIR: process.env.RDLOOP_OUT_DIR || path.resolve(__dirname, '..', 'out'),
  NO_LLM: true  // hard-coded, never overridable
};
