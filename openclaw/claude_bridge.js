const path = require('path');
const config = require('./config');
const { canNotify } = require('./rate_limiter');

const BRIDGE_DIR = process.env.BRIDGE_DIR || path.resolve(__dirname, '..', 'out', 'claude_bridge');

let BridgeIPC;
try {
  BridgeIPC = require('../claude_bridge/ipc').BridgeIPC;
} catch {
  BridgeIPC = null;
}

const CHOICE_EMOJI = {
  y: '\u2705',
  yes: '\u2705',
  n: '\u274C',
  no: '\u274C',
  a: '\u{1F7E2}',
  always: '\u{1F7E2}'
};

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isAllowed(chatId) {
  if (config.TELEGRAM_CHAT_ALLOWLIST.length === 0) return true;
  return config.TELEGRAM_CHAT_ALLOWLIST.includes(String(chatId));
}

function formatPermissionMessage(req) {
  const prompt = escapeHtml(req.prompt || '(no description)').slice(0, 500);
  return `\u{1F510} <b>Permission Request</b>\n\n<pre>${prompt}</pre>\n\n<i>Session: ${escapeHtml(req.context?.session_id || 'unknown')}</i>`;
}

function formatLimitMessage(req) {
  const msg = escapeHtml(req.message || 'Usage limit reached').slice(0, 500);
  const nextPart = req.next_available
    ? `\n<b>Next available</b>: ${escapeHtml(req.next_available)}`
    : '';
  return `\u26A0\uFE0F <b>Claude CLI \u2014 Usage Limit</b>\n\n${msg}${nextPart}\n\n<i>Session: ${escapeHtml(req.context?.session_id || 'unknown')}</i>`;
}

function buildPermissionKeyboard(req) {
  const choices = req.choices || ['y', 'n'];
  const labels = req.choice_labels || ['Approve', 'Reject'];
  const buttons = choices.map((c, i) => {
    const emoji = CHOICE_EMOJI[c] || '';
    return {
      text: `${emoji} ${labels[i] || c}`.trim(),
      callback_data: `cb_perm:${req.id}:${c}`
    };
  });
  return { inline_keyboard: [buttons] };
}

function buildLimitKeyboard(req) {
  return {
    inline_keyboard: [
      [
        { text: '\u25B6\uFE0F Resume When Ready', callback_data: `cb_resume:${req.id}` },
        { text: '\u23F8\uFE0F Dismiss', callback_data: `cb_dismiss:${req.id}` }
      ],
      [
        { text: '\u274C Cancel Session', callback_data: `cb_cancel:${req.id}` }
      ]
    ]
  };
}

const sentRequests = new Set();
const respondedRequests = new Set();
const sentMessageHtml = new Map();
const STALE_THRESHOLD_MS = 10 * 60 * 1000;
const MAX_SENT_CACHE = 500;

function _pruneSentCache() {
  if (sentRequests.size > MAX_SENT_CACHE) {
    const iter = sentRequests.values();
    for (let i = 0; i < sentRequests.size - MAX_SENT_CACHE; i++) {
      sentRequests.delete(iter.next().value);
    }
  }
}

async function pollBridge(bot) {
  if (!bot || !BridgeIPC) return;

  const ipc = new BridgeIPC(BRIDGE_DIR);
  const pending = ipc.listPending();
  const now = Date.now();

  for (const req of pending) {
    if (sentRequests.has(req.id)) continue;

    if (ipc.readResponse(req.id)) {
      sentRequests.add(req.id);
      continue;
    }

    const age = now - new Date(req.created_at || 0).getTime();
    if (sentRequests.size === 0 && age > STALE_THRESHOLD_MS) {
      sentRequests.add(req.id);
      continue;
    }

    if (!canNotify()) continue;

    sentRequests.add(req.id);
    _pruneSentCache();

    let text, keyboard;
    if (req.type === 'permission') {
      text = formatPermissionMessage(req);
      keyboard = buildPermissionKeyboard(req);
    } else if (req.type === 'usage_limit') {
      text = formatLimitMessage(req);
      keyboard = buildLimitKeyboard(req);
    } else {
      continue;
    }

    sentMessageHtml.set(req.id, text);

    for (const chatId of config.TELEGRAM_CHAT_ALLOWLIST) {
      try {
        await bot.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
      } catch (err) {
        console.error(`[openclaw] Failed to send to chat ${chatId}: ${err.message}`);
      }
    }
  }
}

function registerHandlers(bot) {
  if (!bot || !BridgeIPC) return;

  const ipc = new BridgeIPC(BRIDGE_DIR);

  bot.on('callback_query', async (query) => {
    if (!isAllowed(query.message?.chat?.id)) return;

    const data = query.data || '';
    const chatId = String(query.message.chat.id);
    const msgId = query.message.message_id;

    if (data.startsWith('cb_perm:')) {
      const parts = data.split(':');
      const reqId = parts[1];
      const choice = parts[2];

      if (respondedRequests.has(reqId)) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Already responded' }); } catch {}
        return;
      }
      respondedRequests.add(reqId);

      ipc.writeResponse(reqId, choice, 'telegram', chatId);

      const choiceLabel = CHOICE_EMOJI[choice] || '';
      const origHtml = sentMessageHtml.get(reqId) || escapeHtml(query.message.text || '');
      sentMessageHtml.delete(reqId);
      try {
        await bot.editMessageText(
          origHtml + `\n\n${choiceLabel} Response: <b>${escapeHtml(choice)}</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
        );
      } catch {}

      try { await bot.answerCallbackQuery(query.id, { text: `Sent: ${choice}` }); } catch {}
      return;
    }

    if (data.startsWith('cb_resume:')) {
      const reqId = data.split(':')[1];

      if (respondedRequests.has(reqId)) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Already resumed' }); } catch {}
        return;
      }
      respondedRequests.add(reqId);

      ipc.writeResponse(reqId, 'resume', 'telegram', chatId);

      const state = ipc.readState() || {};
      state.action = 'resume';
      ipc.writeState(state);

      const origHtml = sentMessageHtml.get(reqId) || escapeHtml(query.message.text || '');
      sentMessageHtml.delete(reqId);
      try {
        await bot.editMessageText(
          origHtml + '\n\n\u25B6\uFE0F <b>Resume signal sent</b>',
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
        );
      } catch {}

      try { await bot.answerCallbackQuery(query.id, { text: 'Resume signal sent' }); } catch {}
      return;
    }

    if (data.startsWith('cb_dismiss:')) {
      const reqId = data.split(':')[1];
      const origHtml = sentMessageHtml.get(reqId) || escapeHtml(query.message.text || '');
      sentMessageHtml.delete(reqId);
      try {
        await bot.editMessageText(
          origHtml + '\n\n\u23F8\uFE0F <b>Dismissed</b>',
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
        );
      } catch {}

      try { await bot.answerCallbackQuery(query.id, { text: 'Dismissed' }); } catch {}
      return;
    }

    if (data.startsWith('cb_cancel:')) {
      const reqId = data.split(':')[1];

      if (respondedRequests.has(reqId)) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Already cancelled' }); } catch {}
        return;
      }
      respondedRequests.add(reqId);

      ipc.writeResponse(reqId, 'cancel', 'telegram', chatId);

      const state = ipc.readState() || {};
      state.action = 'cancel';
      ipc.writeState(state);

      const origHtml = sentMessageHtml.get(reqId) || escapeHtml(query.message.text || '');
      sentMessageHtml.delete(reqId);
      try {
        await bot.editMessageText(
          origHtml + '\n\n\u274C <b>Session cancelled</b>',
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
        );
      } catch {}

      try { await bot.answerCallbackQuery(query.id, { text: 'Session cancelled' }); } catch {}
    }
  });

  bot.onText(/\/claude_resume/, async (msg) => {
    if (!isAllowed(msg.chat.id)) return;

    const state = ipc.readState();
    if (!state || (state.status !== 'limited' && state.status !== 'exited')) {
      await bot.sendMessage(msg.chat.id, '\u2139\uFE0F No Claude CLI session waiting for resume.', { parse_mode: 'HTML' });
      return;
    }

    state.action = 'resume';
    ipc.writeState(state);

    await bot.sendMessage(msg.chat.id, '\u25B6\uFE0F Resume signal sent to Claude CLI session.', { parse_mode: 'HTML' });
  });

  bot.onText(/\/claude_status/, async (msg) => {
    if (!isAllowed(msg.chat.id)) return;

    const state = ipc.readState();
    if (!state) {
      await bot.sendMessage(msg.chat.id, '\u2139\uFE0F No active Claude Bridge session.', { parse_mode: 'HTML' });
      return;
    }

    const statusEmoji = {
      running: '\u{1F7E2}',
      waiting_approval: '\u{1F7E1}',
      limited: '\u{1F534}',
      resuming: '\u{1F535}',
      exited: '\u26AA',
      error: '\u{1F534}'
    };

    const emoji = statusEmoji[state.status] || '\u2753';
    let text = `${emoji} <b>Claude Bridge Status</b>\n\n`;
    text += `<b>Session</b>: <code>${escapeHtml(state.session_id || 'unknown')}</code>\n`;
    text += `<b>Status</b>: ${escapeHtml(state.status || 'unknown')}\n`;

    if (state.limit_message) {
      text += `<b>Limit</b>: ${escapeHtml(state.limit_message).slice(0, 200)}\n`;
    }
    if (state.next_available) {
      text += `<b>Next available</b>: ${escapeHtml(state.next_available)}\n`;
    }
    if (state.updated_at) {
      text += `<b>Updated</b>: ${escapeHtml(state.updated_at)}\n`;
    }

    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  });
}

function startBridgePoller(bot) {
  if (!bot || !BridgeIPC) {
    console.log('[openclaw] Claude bridge poller disabled (BridgeIPC not available)');
    return null;
  }
  console.log('[openclaw] Claude bridge poller started');
  const interval = setInterval(() => pollBridge(bot), 2000);
  return interval;
}

module.exports = {
  registerHandlers,
  startBridgePoller,
  pollBridge,
  formatPermissionMessage,
  formatLimitMessage,
  escapeHtml,
  isAllowed
};
