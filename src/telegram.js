const API_BASE = 'https://api.telegram.org';

export function createTelegram({ token, fetchImpl = fetch }) {
  const base = `${API_BASE}/bot${token}`;
  async function call(method, body) {
    const res = await fetchImpl(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description || res.status}`);
    return json.result;
  }
  return {
    async getUpdates(offset, timeoutS = 3) {
      const result = await call('getUpdates', {
        offset, timeout: timeoutS, allowed_updates: ['message', 'callback_query'],
      });
      let nextOffset = offset;
      for (const u of result) nextOffset = Math.max(nextOffset || 0, u.update_id + 1);
      return { updates: result, nextOffset };
    },
    async sendMessage(chatId, text, { buttons } = {}) {
      const body = { chat_id: chatId, text };
      if (buttons && buttons.length) {
        body.reply_markup = {
          inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))),
        };
      }
      const r = await call('sendMessage', body);
      return r.message_id;
    },
    async answerCallback(callbackId, text) {
      return call('answerCallbackQuery', { callback_query_id: callbackId, text: text || '' });
    },
    // Show a transient chat action (e.g. "typing…") in the chat. Telegram displays it for ~5s or
    // until the next message, so callers re-send it periodically while work is in flight.
    async sendChatAction(chatId, action = 'typing') {
      return call('sendChatAction', { chat_id: chatId, action });
    },
    // Edit a previously-sent message's text and drop its inline keyboard (omitting
    // reply_markup removes the buttons), e.g. to show the chosen option after a tap.
    async editMessageText(chatId, messageId, text) {
      return call('editMessageText', { chat_id: chatId, message_id: messageId, text });
    },
  };
}

export function parseUpdate(update) {
  if (update.callback_query) {
    const cq = update.callback_query;
    return { kind: 'callback', chatId: cq.message?.chat?.id, callbackId: cq.id, data: cq.data, refMessageId: cq.message?.message_id };
  }
  if (update.message) {
    const m = update.message;
    return {
      kind: m.reply_to_message ? 'reply' : 'text',
      chatId: m.chat?.id, text: m.text || '',
      replyToMessageId: m.reply_to_message?.message_id,
    };
  }
  return { kind: 'other' };
}
