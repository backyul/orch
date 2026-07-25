import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSay } from '../src/say.js';
import { TRANSCRIPT_FILE, readLast } from '../src/transcript.js';
import * as bus from '../src/bus.js';

function fresh(state) {
  fs.rmSync(TRANSCRIPT_FILE, { force: true });
  for (const e of bus.listOutbox()) bus.removeOutbox(e.id);
  bus.writeState({ away: false, lastChannel: undefined, lastChannelAt: undefined, ...state });
}
function fakeLoadTg(sent) {
  return () => ({ tg: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return 1; } }, chatId: '999' });
}

test('telegram-last -> say sends to Telegram, mirrors to transcript, no outbox', async () => {
  fresh({ away: true, lastChannel: 'telegram', lastChannelAt: 50 });
  const sent = []; const printed = [];
  const r = await runSay({ bus, text: 'nightly nudge', loadTg: fakeLoadTg(sent), now: () => 100, print: (s) => printed.push(s) });
  assert.equal(r.channel, 'telegram');
  assert.deepEqual(sent, [{ chatId: '999', text: 'nightly nudge' }]);
  assert.equal(bus.listOutbox().length, 0);
  const t = readLast(5);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0], { ts: 100, from: 'orch', channel: 'telegram', text: 'nightly nudge' });
});

test('terminal-last (present) -> say prints, writes outbox for the daemon sweep, no Telegram', async () => {
  fresh({ away: false, lastChannel: 'terminal', lastChannelAt: 90 });
  const sent = []; const printed = [];
  const r = await runSay({ bus, text: 'status update', loadTg: fakeLoadTg(sent), now: () => 100, print: (s) => printed.push(s) });
  assert.equal(r.channel, 'terminal');
  assert.equal(sent.length, 0);
  assert.ok(printed.join('\n').includes('status update'));
  const ob = bus.listOutbox();
  assert.equal(ob.length, 1);
  assert.equal(ob[0].text, 'status update');
  assert.equal(ob[0].shownAt, 100);
  assert.deepEqual(readLast(5)[0], { ts: 100, from: 'orch', channel: 'terminal', text: 'status update' });
});

test('manual away override -> telegram even when terminal was last', async () => {
  fresh({ away: true, lastChannel: 'terminal', lastChannelAt: 90 });
  const sent = [];
  const r = await runSay({ bus, text: 'x', loadTg: fakeLoadTg(sent), now: () => 100, print: () => {} });
  assert.equal(r.channel, 'telegram');
  assert.equal(sent.length, 1);
});

test('no lastChannel (pre-upgrade state) -> legacy away-flag routing', async () => {
  fresh({ away: false });
  const sent = [];
  let r = await runSay({ bus, text: 'a', loadTg: fakeLoadTg(sent), now: () => 100, print: () => {} });
  assert.equal(r.channel, 'terminal');
  assert.equal(sent.length, 0);
  fresh({ away: true });
  r = await runSay({ bus, text: 'b', loadTg: fakeLoadTg(sent), now: () => 100, print: () => {} });
  assert.equal(r.channel, 'telegram');
  assert.equal(sent.length, 1);
});

test('a broken transcript never blocks delivery (mirror is best-effort)', async () => {
  fresh({ away: true, lastChannel: 'telegram' });
  const sent = [];
  const throwing = { append: () => { throw new Error('disk full'); } };
  const r = await runSay({ bus, text: 'must arrive', loadTg: fakeLoadTg(sent), now: () => 100, print: () => {}, transcript: throwing });
  assert.equal(r.channel, 'telegram');
  assert.deepEqual(sent, [{ chatId: '999', text: 'must arrive' }]);
});
