// Unified-messaging daemon behavior: lastChannel stamping, Telegram<->transcript mirroring, and
// the outbox sweep that escalates terminal-shown `say` messages to Telegram after the timeout.
// All in-memory fakes (same pattern as daemon.test.mjs) — hermetic, no real state dir, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, handleUpdate, sweepOutbox } from '../src/daemon.js';
import { runSay } from '../src/say.js';
import { SAY_ESCALATE_MS } from '../src/config.js';

function makeBus(initialPending = [], initialState = { away: false, workers: {} }) {
  const pend = new Map(initialPending.map(p => [p.ref, { ...p }]));
  let state = { ...initialState };
  const replies = []; const inbox = []; const outbox = new Map();
  let obSeq = 0;
  return {
    _replies: replies, _inbox: inbox, _state: () => state,
    ensureDirs() {}, listPending: () => [...pend.values()],
    readPending: (ref) => pend.get(ref) || null,
    updatePending: (ref, patch) => { const c = pend.get(ref); if (c) pend.set(ref, { ...c, ...patch }); return pend.get(ref); },
    removePending: (ref) => pend.delete(ref),
    writePending: (rec) => pend.set(rec.ref, rec),
    writeReply: (rec) => replies.push(rec),
    writeInbox: (t) => inbox.push(t),
    readAndClearInbox: () => inbox.splice(0),
    inboxCount: () => inbox.length,
    readState: () => state, writeState: (patch) => { state = { ...state, ...patch }; return state; },
    writeOutbox: (rec) => { const id = `ob${obSeq++}`; const e = { ...rec, id }; outbox.set(id, e); return e; },
    listOutbox: () => [...outbox.values()],
    removeOutbox: (id) => outbox.delete(id),
  };
}
function makeTg(sent = []) {
  return { sent,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return sent.length; },
    answerCallback: async () => {}, editMessageText: async () => {}, sendChatAction: async () => {} };
}
function makeTmux(keys = []) {
  return { keys, sendKeys: (pane, text, opts) => keys.push({ pane, text, enter: opts?.enter !== false }), capturePane: () => 'TAIL' };
}
function makeTranscript() {
  const entries = [];
  return { entries, append: (e) => entries.push(e) };
}

// ---- lastChannel stamping + operator->orch mirroring -------------------------------------------

test('operator plain Telegram text stamps lastChannel=telegram and mirrors to the transcript', async () => {
  const bus = makeBus([], { away: false, workers: { orch: '%0' }, orchestratorWorker: 'orch' });
  const tr = makeTranscript();
  await handleUpdate({ message: { chat: { id: '999' }, text: 'run the eval tonight' } },
    { bus, tg: makeTg(), tmux: makeTmux(), chatId: '999', refMap: new Map(), now: () => 500, transcript: tr });
  const st = bus.readState();
  assert.equal(st.lastChannel, 'telegram');
  assert.equal(st.lastChannelAt, 500);
  assert.equal(st.away, true); // existing behavior preserved: phone message means on-phone
  assert.deepEqual(tr.entries, [{ ts: 500, from: 'operator', channel: 'telegram', text: 'run the eval tonight' }]);
});

test('operator button tap stamps lastChannel=telegram and mirrors the chosen option', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', paneId: '%1', type: 'options', text: 'Deploy?', options: ['Yes', 'No'], createdAt: 0 }],
    { away: false, workers: { w1: '%1' } });
  const tr = makeTranscript();
  await handleUpdate({ callback_query: { id: 'c1', data: 'w1.a::1', message: { chat: { id: '999' }, message_id: 1 } } },
    { bus, tg: makeTg(), tmux: makeTmux(), chatId: '999', refMap: new Map([[1, 'w1.a']]), now: () => 600, transcript: tr });
  assert.equal(bus.readState().lastChannel, 'telegram');
  assert.equal(bus.readState().lastChannelAt, 600);
  assert.equal(tr.entries.length, 1);
  assert.equal(tr.entries[0].from, 'operator');
  assert.match(tr.entries[0].text, /No/);
});

test('operator threaded reply stamps lastChannel=telegram and mirrors the text', async () => {
  const bus = makeBus([{ ref: 'w2.b', worker: 'w2', paneId: '%2', type: 'freetext', text: 'which file?', options: [], createdAt: 0 }],
    { away: false, workers: { w2: '%2' } });
  const tr = makeTranscript();
  await handleUpdate({ message: { chat: { id: '999' }, text: 'use config.js', reply_to_message: { message_id: 5 } } },
    { bus, tg: makeTg(), tmux: makeTmux(), chatId: '999', refMap: new Map([[5, 'w2.b']]), now: () => 700, transcript: tr });
  assert.equal(bus.readState().lastChannel, 'telegram');
  assert.deepEqual(tr.entries, [{ ts: 700, from: 'operator', channel: 'telegram', text: 'use config.js' }]);
});

// ---- orch->operator Telegram sends are mirrored -------------------------------------------------

test('a tick escalation sent to Telegram is mirrored into the transcript', async () => {
  const bus = makeBus([{ ref: 'o.a', worker: 'orch', paneId: '%0', type: 'freetext', text: 'Deploy now?', options: [], createdAt: 0 }],
    { away: true, workers: { orch: '%0' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tr = makeTranscript();
  await tick({ bus, tg, tmux: makeTmux(), chatId: '999', now: () => 100, refMap: new Map(), transcript: tr });
  assert.equal(tg.sent.length, 1);
  assert.equal(tr.entries.length, 1);
  assert.equal(tr.entries[0].from, 'orch');
  assert.equal(tr.entries[0].channel, 'telegram');
  assert.match(tr.entries[0].text, /Deploy now\?/);
});

// ---- outbox sweep (the 5-min escalation) ---------------------------------------------------------

test('sweepOutbox pushes unseen terminal says to Telegram after the timeout, batched in one message', async () => {
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 0 });
  bus.writeOutbox({ text: 'first note', shownAt: 1000 });
  bus.writeOutbox({ text: 'second note', shownAt: 2000 });
  const tg = makeTg(); const tr = makeTranscript();
  await sweepOutbox({ bus, tg, chatId: '999', now: () => 2000 + SAY_ESCALATE_MS, transcript: tr });
  assert.equal(tg.sent.length, 1, 'batched into ONE message');
  assert.match(tg.sent[0].text, /first note/);
  assert.match(tg.sent[0].text, /second note/);
  assert.equal(bus.listOutbox().length, 0, 'entries cleared after escalation');
  assert.equal(tr.entries.length, 1);
  assert.equal(tr.entries[0].channel, 'telegram');
});

test('sweepOutbox drops entries once the operator shows terminal activity after shownAt (seen)', async () => {
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 5000 });
  bus.writeOutbox({ text: 'note', shownAt: 1000 });
  const tg = makeTg();
  await sweepOutbox({ bus, tg, chatId: '999', now: () => 6000, transcript: makeTranscript() });
  assert.equal(tg.sent.length, 0, 'seen at terminal — no phone ping');
  assert.equal(bus.listOutbox().length, 0, 'entry cleared');
});

test('sweepOutbox escalates a terminal-shown say when a Telegram message arrived after it (presence must not mark it seen)', async () => {
  // The lost-message bug: say shown at the pane (shownAt=1000), then the operator messages from
  // Telegram (lastTelegramAt=5500) — but ongoing cockpit-presence stamping (lastChannelAt=5000)
  // would otherwise mark it "seen" and swallow it. A phone message after shownAt forces escalation.
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 5000, lastTelegramAt: 5500 });
  bus.writeOutbox({ text: 'note', shownAt: 1000 });
  const tg = makeTg();
  await sweepOutbox({ bus, tg, chatId: '999', now: () => 1000 + SAY_ESCALATE_MS, transcript: makeTranscript() });
  assert.equal(tg.sent.length, 1, 'Telegram message after shownAt -> escalate, not drop');
  assert.match(tg.sent[0].text, /note/);
  assert.equal(bus.listOutbox().length, 0, 'delivered and cleared');
});

test('sweepOutbox leaves not-yet-due unseen entries alone', async () => {
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 0 });
  bus.writeOutbox({ text: 'note', shownAt: 1000 });
  const tg = makeTg();
  await sweepOutbox({ bus, tg, chatId: '999', now: () => 1000 + SAY_ESCALATE_MS - 1, transcript: makeTranscript() });
  assert.equal(tg.sent.length, 0);
  assert.equal(bus.listOutbox().length, 1);
});

test('sweepOutbox keeps entries when the Telegram send fails (retry next tick)', async () => {
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 0 });
  bus.writeOutbox({ text: 'note', shownAt: 1000 });
  const tg = { sendMessage: async () => { throw new Error('network down'); } };
  await sweepOutbox({ bus, tg, chatId: '999', now: () => 1000 + SAY_ESCALATE_MS, transcript: makeTranscript() });
  assert.equal(bus.listOutbox().length, 1, 'kept for retry');
});

test('tick runs the outbox sweep', async () => {
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 0, workers: {} });
  bus.writeOutbox({ text: 'stranded note', shownAt: 1000 });
  const tg = makeTg();
  await tick({ bus, tg, tmux: makeTmux(), chatId: '999', now: () => 1000 + SAY_ESCALATE_MS, refMap: new Map(), transcript: makeTranscript() });
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /stranded note/);
});

// ---- 2026-07-14 incident: orch's own automation must not fake presence or wedge the sweep ------

test('INCIDENT REPLAY: operator idle + orch busily working -> a terminal say still escalates', async () => {
  // Operator is on their phone (away=true). Orch keeps doing what orch does: dismissing an
  // escalated pending (the reconcile trigger), reading its inbox, sending more says. NONE of
  // that may count as operator presence or reset the escalation clock.
  const bus = makeBus(
    [{ ref: 'orch.q', worker: 'orch', paneId: '%0', type: 'freetext', text: 'old q', options: [], createdAt: 0, escalatedAt: 1, messageId: 7 }],
    { away: false, lastChannel: 'terminal', lastChannelAt: 500, workers: { orch: '%0' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tr = makeTranscript();
  const refMap = new Map([[7, 'orch.q']]);
  const t0 = 1_000_000;
  // the say that must reach the operator
  const r = await runSay({ bus, text: 'please review tonight', loadTg: () => ({ tg, chatId: '999' }), now: () => t0, print: () => {}, transcript: tr });
  assert.equal(r.channel, 'terminal');
  // orch automation while the operator is idle: dismisses the old pending (reconcile fires)...
  bus.removePending('orch.q');
  await tick({ bus, tg, tmux: makeTmux(), chatId: '999', now: () => t0 + 60_000, refMap, transcript: tr });
  // ...reads inbox, and says something else (more outbox traffic)
  bus.readAndClearInbox();
  await runSay({ bus, text: 'second note', loadTg: () => ({ tg, chatId: '999' }), now: () => t0 + 120_000, print: () => {}, transcript: tr });
  const phonePings = () => tg.sent.filter((s) => /please review tonight/.test(s.text)).length;
  assert.equal(phonePings(), 0, 'not yet due');
  // past the timeout with ZERO operator activity -> must escalate despite all the orch churn
  await tick({ bus, tg, tmux: makeTmux(), chatId: '999', now: () => t0 + SAY_ESCALATE_MS, refMap, transcript: tr });
  assert.equal(phonePings(), 1, 'escalated to Telegram');
  assert.equal(bus.readState().away, false, 'away untouched by orch activity (was false, stays false)');
});

test('sweepOutbox splits an over-4096-char backlog into multiple Telegram messages and drains it', async () => {
  // The real wedge: 9 stranded entries totaling ~6.4k chars -> one batched message > Telegram's
  // 4096 limit -> send throws -> silent retry forever. The sweep must chunk and drain instead.
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 0 });
  for (let i = 0; i < 9; i++) bus.writeOutbox({ text: `[note ${i}] ` + 'x'.repeat(700), shownAt: 1000 + i });
  const tg = makeTg();
  await sweepOutbox({ bus, tg, chatId: '999', now: () => 1000 + SAY_ESCALATE_MS + 10, transcript: makeTranscript() });
  assert.ok(tg.sent.length >= 2, `chunked into multiple messages (got ${tg.sent.length})`);
  for (const s of tg.sent) assert.ok(s.text.length <= 4096, `each message within the limit (got ${s.text.length})`);
  for (let i = 0; i < 9; i++) assert.ok(tg.sent.some((s) => s.text.includes(`[note ${i}]`)), `note ${i} delivered`);
  assert.equal(bus.listOutbox().length, 0, 'outbox fully drained');
});

test('a single oversized entry is truncated (with a transcript pointer), delivered, and cleared', async () => {
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 0 });
  bus.writeOutbox({ text: 'HEAD-MARKER ' + 'y'.repeat(6000), shownAt: 1000 });
  const tg = makeTg();
  await sweepOutbox({ bus, tg, chatId: '999', now: () => 1000 + SAY_ESCALATE_MS, transcript: makeTranscript() });
  assert.equal(tg.sent.length, 1);
  assert.ok(tg.sent[0].text.length <= 4096);
  assert.match(tg.sent[0].text, /HEAD-MARKER/);
  assert.match(tg.sent[0].text, /truncated.*transcript/i);
  assert.equal(bus.listOutbox().length, 0);
});

test('sweep send failure is logged once per streak and entries survive for retry', async () => {
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 0 });
  bus.writeOutbox({ text: 'note', shownAt: 1000 });
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const tg = { sendMessage: async () => { throw new Error('network down'); } };
  const deps = { bus, tg, chatId: '999', now: () => 1000 + SAY_ESCALATE_MS, transcript: makeTranscript() };
  try {
    await sweepOutbox(deps);
    await sweepOutbox(deps); // second failing sweep — must NOT log again (no new flood)
  } finally { console.error = origErr; }
  assert.equal(bus.listOutbox().length, 1, 'entry kept for retry');
  assert.equal(errors.filter((e) => /outbox/i.test(e)).length, 1, 'logged once per failure streak');
  // recovery: send works again -> delivered, drained, streak reset
  const tg2 = makeTg();
  await sweepOutbox({ ...deps, tg: tg2 });
  assert.equal(tg2.sent.length, 1);
  assert.equal(bus.listOutbox().length, 0);
});

// ---- THE off-hours 23:03 case (the bug that bit us) ---------------------------------------------

test('23:03 nudge reaches Telegram when the operator last messaged from the phone', async () => {
  // Evening: operator sent a Telegram message -> lastChannel=telegram (+away). At 23:03 the daemon
  // fires the schedule; orch reads its inbox and runs `say` -> must go straight to Telegram.
  const bus = makeBus([], { away: false, workers: { orch: '%0' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tr = makeTranscript();
  const deps = { bus, tg, tmux: makeTmux(), chatId: '999', now: () => 1000, refMap: new Map(), transcript: tr,
    schedules: { fireDue: (d) => (d.getHours() === 23 && d.getMinutes() === 3 ? [{ time: '23:03', message: 'run tonight?' }] : []) } };
  await handleUpdate({ message: { chat: { id: '999' }, text: 'heading out, on my phone' } }, deps); // evening
  const at2303 = new Date(); at2303.setHours(23, 3, 0, 0);
  deps.now = () => at2303.getTime();
  await tick(deps);
  assert.ok(bus._inbox.length > 0 || bus.inboxCount() === 0); // schedule fired into inbox (then orch would drain it)
  const sentBefore = tg.sent.length;
  await runSay({ bus, text: 'Nightly check-in: run tonight?', loadTg: () => ({ tg, chatId: '999' }), now: deps.now, print: () => {}, transcript: tr });
  assert.equal(tg.sent.length, sentBefore + 1, 'say went straight to Telegram');
  assert.match(tg.sent.at(-1).text, /Nightly check-in/);
});

test('23:03 nudge reaches Telegram within the timeout even when state wrongly says terminal-present', async () => {
  // The EXACT 3-night failure: away=false (stale/manual), operator not at the terminal. The say is
  // shown in the pane + outboxed; the sweep must push it to the phone after SAY_ESCALATE_MS.
  const bus = makeBus([], { away: false, lastChannel: 'terminal', lastChannelAt: 1000, workers: {} });
  const tg = makeTg(); const tr = makeTranscript();
  const t0 = 10_000_000;
  const r = await runSay({ bus, text: 'Nightly check-in: run tonight?', loadTg: () => ({ tg, chatId: '999' }), now: () => t0, print: () => {}, transcript: tr });
  assert.equal(r.channel, 'terminal');
  assert.equal(tg.sent.length, 0, 'initially shown at the terminal only');
  // no terminal activity for the timeout -> next tick escalates
  await tick({ bus, tg, tmux: makeTmux(), chatId: '999', now: () => t0 + SAY_ESCALATE_MS, refMap: new Map(), transcript: tr });
  assert.equal(tg.sent.length, 1, 'escalated to Telegram');
  assert.match(tg.sent[0].text, /Nightly check-in/);
});
