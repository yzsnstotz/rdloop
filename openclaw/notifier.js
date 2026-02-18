const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const api = require('./api_client');
const { canNotify } = require('./rate_limiter');

const STATE_FILE = path.join(__dirname, 'openclaw_state.json');

const STATE_EMOJI = {
  RUNNING: '\u{1F7E2}',
  PAUSED: '\u{1F7E1}',
  READY_FOR_REVIEW: '\u2705',
  FAILED: '\u{1F534}'
};

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function computeFingerprint(task) {
  const raw = [
    task.task_id || '',
    task.state || '',
    task.pause_reason_code || '',
    task.last_decision || '',
    String(task.current_attempt || 0),
    String(task.state_version || 0)
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function loadFingerprints() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return data.fingerprints || {};
  } catch {
    return {};
  }
}

function saveFingerprints(fingerprints) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ fingerprints }, null, 2));
}

function formatNotification(task) {
  const emoji = STATE_EMOJI[task.state] || '\u2753';
  const reason = task.pause_reason_code ? ` (${escapeHtml(task.pause_reason_code)})` : '';
  const att = task.current_attempt ? `\n<b>Attempt</b>: ${task.current_attempt}/${task.max_attempts || '?'}` : '';
  const msg = task.message ? `\n<b>Message</b>: ${escapeHtml(task.message).slice(0, 200)}` : '';
  return `<b>State Change</b>: <code>${escapeHtml(task.task_id)}</code>\n<b>New State</b>: ${emoji} ${escapeHtml(task.state)}${reason}${att}${msg}`;
}

async function pollOnce(bot) {
  if (!bot) return;
  const fingerprints = loadFingerprints();
  let data;
  try {
    data = await api.getTasks(100);
  } catch {
    return; // silently skip on API error
  }

  const items = data.items || [];
  let changed = false;

  for (const task of items) {
    const fp = computeFingerprint(task);
    const prev = fingerprints[task.task_id];
    if (prev !== fp) {
      fingerprints[task.task_id] = fp;
      changed = true;

      // Skip initial population (no previous fingerprint)
      if (prev === undefined) continue;

      if (!canNotify()) continue;

      const text = formatNotification(task);
      for (const chatId of config.TELEGRAM_CHAT_ALLOWLIST) {
        try {
          await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        } catch { /* best effort */ }
      }
    }
  }

  if (changed) {
    saveFingerprints(fingerprints);
  }
}

function startNotifier(bot) {
  if (!bot) {
    console.log('[openclaw] No bot instance, notifier disabled');
    return null;
  }
  console.log(`[openclaw] Notifier started (poll interval: ${config.RDLOOP_POLL_INTERVAL}ms)`);
  // Initial poll to seed fingerprints
  pollOnce(bot);
  const interval = setInterval(() => pollOnce(bot), config.RDLOOP_POLL_INTERVAL);
  return interval;
}

module.exports = { startNotifier, pollOnce, computeFingerprint, formatNotification, loadFingerprints, saveFingerprints };
