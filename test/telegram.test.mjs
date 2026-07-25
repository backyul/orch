import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegram, parseUpdate } from '../src/telegram.js';

function fakeFetch(recorder, result) {
  return async (url, opts) => {
    recorder.push({ url, body: JSON.parse(opts.body) });
    return { json: async () => ({ ok: true, result }) };
  };
}

test('sendMessage posts chat_id+text and returns message_id', async () => {
  const rec = [];
  const tg = createTelegram({ token: 'T', fetchImpl: fakeFetch(rec, { message_id: 77 }) });
  const id = await tg.sendMessage('999', 'hello');
  assert.equal(id, 77);
  assert.match(rec[0].url, /\/botT\/sendMessage$/);
  assert.equal(rec[0].body.chat_id, '999');
  assert.equal(rec[0].body.text, 'hello');
});

test('sendMessage builds inline_keyboard from buttons', async () => {
  const rec = [];
  const tg = createTelegram({ token: 'T', fetchImpl: fakeFetch(rec, { message_id: 1 }) });
  await tg.sendMessage('999', 'pick', { buttons: [[{ text: 'Yes', data: 'w.a::0' }], [{ text: 'No', data: 'w.a::1' }]] });
  assert.deepEqual(rec[0].body.reply_markup.inline_keyboard, [
    [{ text: 'Yes', callback_data: 'w.a::0' }],
    [{ text: 'No', callback_data: 'w.a::1' }],
  ]);
});

test('sendChatAction posts chat_id + action', async () => {
  const rec = [];
  const tg = createTelegram({ token: 'T', fetchImpl: fakeFetch(rec, true) });
  await tg.sendChatAction('999', 'typing');
  assert.match(rec[0].url, /\/botT\/sendChatAction$/);
  assert.deepEqual(rec[0].body, { chat_id: '999', action: 'typing' });
});

test('getUpdates computes nextOffset', async () => {
  const tg = createTelegram({ token: 'T', fetchImpl: async () => ({ json: async () => ({ ok: true, result: [{ update_id: 5 }, { update_id: 6 }] }) }) });
  const { updates, nextOffset } = await tg.getUpdates(0, 3);
  assert.equal(updates.length, 2);
  assert.equal(nextOffset, 7);
});

test('failed response throws', async () => {
  const tg = createTelegram({ token: 'T', fetchImpl: async () => ({ json: async () => ({ ok: false, description: 'bad' }) }) });
  await assert.rejects(() => tg.sendMessage('1', 'x'), /telegram sendMessage failed: bad/);
});

test('editMessageText posts chat_id+message_id+text and no reply_markup (drops buttons)', async () => {
  const rec = [];
  const tg = createTelegram({ token: 'T', fetchImpl: fakeFetch(rec, {}) });
  await tg.editMessageText('999', 42, '✅ chosen: No');
  assert.match(rec[0].url, /\/botT\/editMessageText$/);
  assert.equal(rec[0].body.chat_id, '999');
  assert.equal(rec[0].body.message_id, 42);
  assert.equal(rec[0].body.text, '✅ chosen: No');
  assert.equal(rec[0].body.reply_markup, undefined);
});

test('parseUpdate classifies callback, reply, and text', () => {
  assert.equal(parseUpdate({ callback_query: { id: 'c', data: 'w.a::0', message: { chat: { id: 1 }, message_id: 9 } } }).kind, 'callback');
  assert.equal(parseUpdate({ message: { chat: { id: 1 }, text: 'hi', reply_to_message: { message_id: 9 } } }).kind, 'reply');
  assert.equal(parseUpdate({ message: { chat: { id: 1 }, text: 'hi' } }).kind, 'text');
});
