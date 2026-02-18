const config = require('./config');
const api = require('./api_client');

const STATE_EMOJI = {
  RUNNING: '\u{1F7E2}',          // green circle
  PAUSED: '\u{1F7E1}',           // yellow circle
  READY_FOR_REVIEW: '\u2705',    // check mark
  FAILED: '\u{1F534}'            // red circle
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isAllowed(chatId) {
  if (config.TELEGRAM_CHAT_ALLOWLIST.length === 0) return true;
  return config.TELEGRAM_CHAT_ALLOWLIST.includes(String(chatId));
}

function formatTaskList(items, hasMore, cursor) {
  if (!items || items.length === 0) {
    return '<b>rdloop Dashboard</b>\n\nNo tasks found.';
  }
  let msg = '<b>rdloop Dashboard</b>\n\n';
  items.forEach((t, i) => {
    const emoji = STATE_EMOJI[t.state] || '\u2753';
    const att = t.current_attempt ? ` \u2014 att ${t.current_attempt}` : '';
    const reason = t.state === 'PAUSED' && t.message ? ` \u2014 ${escapeHtml(t.message).slice(0, 60)}` : '';
    msg += `${i + 1}. <code>${escapeHtml(t.task_id)}</code> \u2014 ${emoji} ${escapeHtml(t.state)}${att}${reason}\n`;
  });
  return msg;
}

function buildKeyboard(hasMore, cursor) {
  const buttons = [];
  if (hasMore && cursor) {
    buttons.push([{ text: '\u25B6 Next', callback_data: `rdloop_next:${cursor}` }]);
  }
  return buttons.length > 0 ? { inline_keyboard: buttons } : undefined;
}

function startBot() {
  if (!config.TELEGRAM_BOT_TOKEN) {
    console.log('[openclaw] TELEGRAM_BOT_TOKEN not set, bot disabled');
    return null;
  }

  // Dynamic require to avoid crash when token not set
  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.onText(/\/rdloop/, async (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    try {
      const data = await api.getTasks(5);
      const text = formatTaskList(data.items, !!data.next_cursor, data.next_cursor);
      const keyboard = buildKeyboard(!!data.next_cursor, data.next_cursor);
      await bot.sendMessage(msg.chat.id, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `Error: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.on('callback_query', async (query) => {
    if (!isAllowed(query.message.chat.id)) return;
    const data = query.data || '';
    if (data.startsWith('rdloop_next:')) {
      const cursor = data.slice('rdloop_next:'.length);
      try {
        const result = await api.getTasks(5, cursor);
        const text = formatTaskList(result.items, !!result.next_cursor, result.next_cursor);
        const keyboard = buildKeyboard(!!result.next_cursor, result.next_cursor);
        await bot.editMessageText(text, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
      } catch (err) {
        await bot.answerCallbackQuery(query.id, { text: `Error: ${err.message}` });
      }
    }
    await bot.answerCallbackQuery(query.id);
  });

  console.log('[openclaw] Telegram bot started');
  return bot;
}

module.exports = { startBot, formatTaskList, escapeHtml, isAllowed, STATE_EMOJI };
