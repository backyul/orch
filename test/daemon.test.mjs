import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, handleUpdate, formatPending, buttonsFor, enrichPermissions, nudgeOrchestrator, triageNote, isAgentBusy, shorten, detectWorkerInput } from '../src/daemon.js';

function makeBus(initialPending = [], initialState = { away: false, workers: {} }) {
  const pend = new Map(initialPending.map(p => [p.ref, { ...p }]));
  let state = { ...initialState };
  const replies = []; const inbox = [];
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
  };
}
function makeTg(sent = [], answered = [], edits = [], actions = []) {
  return { sent, answered, edits, actions,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return sent.length; },
    answerCallback: async (id, t) => { answered.push({ id, t }); },
    editMessageText: async (chatId, messageId, text) => { edits.push({ chatId, messageId, text }); },
    sendChatAction: async (chatId, action) => { actions.push({ chatId, action }); } };
}
function makeTmux(keys = []) {
  return { keys, sendKeys: (pane, text, opts) => keys.push({ pane, text, enter: opts?.enter !== false }), capturePane: () => 'TAIL' };
}

test('tick escalates away pending with buttons + records messageId', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', paneId: '%1', type: 'options', text: 'Deploy?', options: ['Yes', 'No'], createdAt: 0 }],
    { away: true, workers: { w1: '%1' }, orchestratorWorker: 'w1' });
  const tg = makeTg();
  const refMap = new Map();
  await tick({ bus, tg, tmux: makeTmux(), chatId: '999', now: () => 100, refMap });
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /w1 needs you/);
  assert.deepEqual(tg.sent[0].opts.buttons, [[{ text: 'Yes', data: 'w1.a::0' }], [{ text: 'No', data: 'w1.a::1' }]]);
  assert.equal(bus.readPending('w1.a').escalatedAt, 100);
  assert.equal(refMap.get(1), 'w1.a');
});

test('tick does not re-escalate already escalated', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', paneId: '%1', type: 'freetext', text: 'x', options: [], createdAt: 0, escalatedAt: 5, messageId: 1 }],
    { away: true });
  const tg = makeTg();
  await tick({ bus, tg, chatId: '999', now: () => 100, refMap: new Map() });
  assert.equal(tg.sent.length, 0);
});

test('callback delivers chosen option to pane + clears pending', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', paneId: '%1', type: 'options', text: 'Deploy?', options: ['Yes', 'No'], createdAt: 0 }]);
  const tg = makeTg(); const tmux = makeTmux();
  await handleUpdate({ callback_query: { id: 'c1', data: 'w1.a::1', message: { chat: { id: '999' }, message_id: 1 } } },
    { bus, tg, tmux, chatId: '999', refMap: new Map([[1, 'w1.a']]), now: () => 1 });
  // options select via the option NUMBER (index+1 = 2 for 'No'), no trailing Enter
  assert.deepEqual(tmux.keys[0], { pane: '%1', text: '2', enter: false });
  assert.equal(bus.readPending('w1.a'), null);
  assert.equal(tg.answered.length, 1);
  // buttons collapse: original message edited to show the choice
  assert.equal(tg.edits.length, 1);
  assert.equal(tg.edits[0].messageId, 1);
  assert.match(tg.edits[0].text, /You chose: No/);
  assert.ok(!/w1\.a|orch\./.test(tg.edits[0].text), 'collapse message should not show the ref');
});

test('reply threaded to escalation routes free-text to pane', async () => {
  const bus = makeBus([{ ref: 'w2.b', worker: 'w2', paneId: '%2', type: 'freetext', text: 'which file?', options: [], createdAt: 0 }]);
  const tg = makeTg(); const tmux = makeTmux();
  await handleUpdate({ message: { chat: { id: '999' }, text: 'use config.js', reply_to_message: { message_id: 5 } } },
    { bus, tg, tmux, chatId: '999', refMap: new Map([[5, 'w2.b']]), now: () => 1 });
  assert.deepEqual(tmux.keys[0], { pane: '%2', text: 'use config.js', enter: true });
  assert.equal(bus.readPending('w2.b'), null);
});

test('deliverReply prefers the registered session-qualified target over the bare hook pane id', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', paneId: '%1', type: 'freetext', text: 'q', options: [], createdAt: 0 }],
    { away: false, workers: { w1: 'sess:%1' } });
  const tg = makeTg(); const tmux = makeTmux();
  await handleUpdate({ message: { chat: { id: '999' }, text: 'go', reply_to_message: { message_id: 5 } } },
    { bus, tg, tmux, chatId: '999', refMap: new Map([[5, 'w1.a']]), now: () => 1 });
  assert.equal(tmux.keys[0].pane, 'sess:%1'); // registered target, not the ambiguous bare %1
});

test('/away and /back toggle state', async () => {
  const bus = makeBus(); const tg = makeTg();
  const deps = { bus, tg, tmux: makeTmux(), chatId: '999', refMap: new Map(), now: () => 7 };
  await handleUpdate({ message: { chat: { id: '999' }, text: '/away' } }, deps);
  assert.equal(bus.readState().away, true);
  await handleUpdate({ message: { chat: { id: '999' }, text: '/back' } }, deps);
  assert.equal(bus.readState().away, false);
});

test('plain text from user is queued to inbox and nudges the orchestrator pane', async () => {
  const bus = makeBus([], { away: false, workers: { orch: 'orchsess:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tmux = makeTmux();
  await handleUpdate({ message: { chat: { id: '999' }, text: 'what are the workers doing?' } },
    { bus, tg, tmux, chatId: '999', refMap: new Map(), now: () => 1 });
  assert.equal(bus._inbox.length, 1);
  assert.match(bus._inbox[0], /what are the workers doing/);
  assert.equal(tmux.keys[0].pane, 'orchsess:%1');            // nudged the orch pane
  assert.match(tmux.keys[0].text, /cli\.js inbox/);
});

test('tick escalates an ORCHESTRATOR pending to the user with buttons', async () => {
  const bus = makeBus([{ ref: 'orch.a', worker: 'orch', paneId: 'o:%1', type: 'options', text: 'Deploy?', options: ['Yes', 'No'], createdAt: 0 }],
    { away: true, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const refMap = new Map();
  await tick({ bus, tg, tmux: makeTmux(), chatId: '999', now: () => 5, refMap });
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /orch needs you/);
  assert.ok(tg.sent[0].opts.buttons);
});

test('tick TRIAGES a worker pending to the orchestrator (inbox + nudge), not the user', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', paneId: 'w:%1', type: 'options', text: 'Run tests?', options: ['Yes', 'No'], createdAt: 0 }],
    { away: true, workers: { w1: 'w:%1', orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tmux = makeTmux();
  await tick({ bus, tg, tmux, chatId: '999', now: () => 5, refMap: new Map() });
  assert.equal(tg.sent.length, 0);                          // user NOT pinged
  assert.equal(bus._inbox.length, 1);
  assert.match(bus._inbox[0], /Worker "w1" needs input/);
  assert.match(bus._inbox[0], /cli\.js answer w1\.a/);
  assert.equal(tmux.keys.at(-1).pane, 'o:%1');              // orchestrator nudged
  assert.equal(bus.readPending('w1.a').escalatedAt, 5);     // marked handed-off
});

test('tick notifies the user once when a worker needs input but the orchestrator is down', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', paneId: 'w:%1', type: 'freetext', text: 'which file?', options: [], createdAt: 0 }],
    { away: true, workers: { w1: 'w:%1' }, orchestratorWorker: 'orch' }); // no orch in workers
  const tg = makeTg();
  const deps = { bus, tg, tmux: makeTmux(), chatId: '999', now: () => 5, refMap: new Map() };
  await tick(deps);
  await tick(deps); // second tick must NOT re-notify
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /orchestrator isn't running/);
});

test('tick re-reminds orch about a still-blocked worker after the cooldown', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', type: 'freetext', text: 'export or skip?', _source: 'idle-watch', createdAt: 0, escalatedAt: 1000 }],
    { away: true, workers: { w1: 'w:%1', orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg();
  const tmux = { capturePane: () => '❯ idle at prompt', sendKeys() {} }; // worker + orch both idle
  await tick({ bus, tg, tmux, chatId: '999', now: () => 1000 + 130000, refMap: new Map() });
  assert.equal(bus._inbox.length, 1);                          // re-reminded, not stranded
  assert.match(bus._inbox[0], /Worker "w1" needs input/);
  assert.ok(bus.readPending('w1.a').escalatedAt >= 131000);    // cooldown reset
});

test('tick does NOT re-remind before the cooldown elapses', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', type: 'freetext', text: 'q', _source: 'idle-watch', createdAt: 0, escalatedAt: 1000 }],
    { away: true, workers: { w1: 'w:%1', orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg();
  const tmux = { capturePane: () => '❯ idle', sendKeys() {} };
  await tick({ bus, tg, tmux, chatId: '999', now: () => 1000 + 5000, refMap: new Map() });
  assert.equal(bus._inbox.length, 0);                          // within cooldown -> quiet
});

test('detectWorkerInput signals only after SUSTAINED idle (deduped), never the orchestrator', () => {
  const bus = makeBus([], { workers: { w1: 'w:%1', orch: 'o:%1' }, orchestratorWorker: 'orch' });
  let t = 1000;
  const deps = { bus, tmux: { capturePane: () => 'Ready. Should I proceed in order or jump?' }, now: () => t };
  detectWorkerInput(deps);                        // first sighting -> start the idle timer, no signal
  assert.equal(bus.listPending().length, 0, 'no signal on the first (brief) idle frame');
  t += 9000; detectWorkerInput(deps);             // idle sustained past the debounce -> signal
  const p = bus.listPending().find((x) => x.worker === 'w1');
  assert.ok(p, 'sustained-idle worker gets a pending');
  assert.equal(p._source, 'idle-watch');
  assert.match(p.text, /proceed in order or jump/); // carries the captured question
  detectWorkerInput(deps); // dedup, still one
  assert.equal(bus.listPending().filter((x) => x.worker === 'w1').length, 1);
  assert.equal(bus.listPending().some((x) => x.worker === 'orch'), false); // orch never surveilled
});

test('detectWorkerInput does NOT signal a worker that is only briefly idle between tool calls', () => {
  const bus = makeBus([], { workers: { w1: 'w:%1' }, orchestratorWorker: 'orch' });
  let t = 1000;
  const deps = { bus, now: () => t };
  deps.tmux = { capturePane: () => 'Which one — a or b?' }; // a real prompt, so only the debounce gates it
  detectWorkerInput(deps);            // idle frame -> timer starts
  t += 2000;
  deps.tmux = { capturePane: () => 'back to work… esc to interrupt' };
  detectWorkerInput(deps);            // busy again before the debounce elapsed -> timer reset
  assert.equal(bus.listPending().length, 0); // never signaled
});

test('a dismissed flag does NOT re-fire while the worker stays idle (once per episode)', () => {
  const bus = makeBus([], { workers: { w1: 'w:%1' }, orchestratorWorker: 'orch' });
  let t = 1000;
  const deps = { bus, now: () => t, tmux: { capturePane: () => 'Ready. Retry the failed batch?' } };
  detectWorkerInput(deps); t += 9000; detectWorkerInput(deps); // sustained idle on a blocked prompt -> signal
  assert.equal(bus.listPending().length, 1);
  bus.removePending(bus.listPending()[0].ref);                 // orch: `cli.js dismiss <ref>`
  t += 30000; detectWorkerInput(deps);                          // STILL idle, long after
  assert.equal(bus.listPending().length, 0, 'no re-fire after dismiss within the same idle episode');
  // …until the worker actually works again: busy -> idle = NEW episode -> one fresh signal
  deps.tmux = { capturePane: () => 'crunching… esc to interrupt' };
  detectWorkerInput(deps);
  deps.tmux = { capturePane: () => 'Ready. Which series next?' };
  detectWorkerInput(deps); t += 9000; detectWorkerInput(deps);
  assert.equal(bus.listPending().length, 1, 'new busy->idle episode re-signals once');
});

test('a worker resting at an empty prompt (finished, no question) is NOT signaled', () => {
  const bus = makeBus([], { workers: { w1: 'w:%1' }, orchestratorWorker: 'orch' });
  let t = 1000;
  // Done with a task: last output is a statement, below it Claude's empty input box + footer chrome.
  const resting = '● Done. Migrated all 111 data files.\n>\n  ? for shortcuts\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  const deps = { bus, now: () => t, tmux: { capturePane: () => resting } };
  detectWorkerInput(deps); t += 9000; detectWorkerInput(deps); // sustained idle, but not blocked
  assert.equal(bus.listPending().length, 0, 'a resting worker generates no idle-watch ticket');
  t += 60000; detectWorkerInput(deps);                          // long after -> still quiet
  assert.equal(bus.listPending().length, 0);
});

test('a worker showing a selector/permission dialog IS signaled (blocked, not resting)', () => {
  const bus = makeBus([], { workers: { w1: 'w:%1' }, orchestratorWorker: 'orch' });
  let t = 1000;
  const selector = 'Grant Bash permission?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently';
  const deps = { bus, now: () => t, tmux: { capturePane: () => selector } };
  detectWorkerInput(deps); t += 9000; detectWorkerInput(deps);
  const p = bus.listPending().find((x) => x.worker === 'w1');
  assert.ok(p, 'a blocked worker (selector on the pane) escalates');
  assert.equal(p._source, 'idle-watch');
});

test('triageNote tells orch how to dismiss a nothing-needed flag', () => {
  const note = triageNote({ ref: 'w1.a', worker: 'w1', text: 'idle', options: [] });
  assert.match(note, /dismiss w1\.a/);
});

test('detectWorkerInput clears its idle flag when the worker goes busy', () => {
  const bus = makeBus([], { workers: { w1: 'w:%1' }, orchestratorWorker: 'orch' });
  let t = 1000;
  const deps = { bus, now: () => t, tmux: { capturePane: () => 'Idle — which database?' } };
  detectWorkerInput(deps); t += 9000; detectWorkerInput(deps);
  assert.equal(bus.listPending().length, 1);
  deps.tmux = { capturePane: () => 'crunching… esc to interrupt' };
  detectWorkerInput(deps);
  assert.equal(bus.listPending().length, 0); // busy -> stale idle flag cleared
});

test('detectWorkerInput never touches a non-idle-watch pending (e.g. permission) when busy', () => {
  const bus = makeBus([{ ref: 'w1.perm', worker: 'w1', type: 'permission', text: 'x', createdAt: 0 }],
    { workers: { w1: 'w:%1' }, orchestratorWorker: 'orch' });
  detectWorkerInput({ bus, tmux: { capturePane: () => 'esc to interrupt' }, now: () => 1 });
  assert.ok(bus.readPending('w1.perm'), 'permission pending survives');
});

test('an operator Telegram message triggers an immediate "typing…"', async () => {
  const bus = makeBus([], { away: false, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tmux = makeTmux();
  await handleUpdate({ message: { chat: { id: '999' }, text: 'how are the workers?' } },
    { bus, tg, tmux, chatId: '999', refMap: new Map(), now: () => 500 });
  assert.deepEqual(tg.actions, [{ chatId: '999', action: 'typing' }]);
});

test('tick shows Telegram "typing…" while away and the orchestrator is generating', async () => {
  const bus = makeBus([], { away: true, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg();
  const tmux = { capturePane: () => '✽ Composing… (3s) esc to interrupt', sendKeys() {} };
  await tick({ bus, tg, tmux, chatId: '999', now: () => 1000, refMap: new Map() });
  assert.deepEqual(tg.actions, [{ chatId: '999', action: 'typing' }]);
});

test('no typing when the operator is present (replies show in the pane, not Telegram)', async () => {
  const bus = makeBus([], { away: false, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg();
  const tmux = { capturePane: () => 'esc to interrupt', sendKeys() {} };
  await tick({ bus, tg, tmux, chatId: '999', now: () => 1000, refMap: new Map() });
  assert.equal(tg.actions.length, 0);
});

test('no typing when the orchestrator is idle', async () => {
  const bus = makeBus([], { away: true, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg();
  const tmux = { capturePane: () => '❯ idle at prompt', sendKeys() {} };
  await tick({ bus, tg, tmux, chatId: '999', now: () => 1000, refMap: new Map() });
  assert.equal(tg.actions.length, 0);
});

test('typing is throttled to ~4s between re-sends', async () => {
  const bus = makeBus([], { away: true, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg();
  const tmux = { capturePane: () => 'esc to interrupt', sendKeys() {} };
  let t = 1000;
  const deps = { bus, tg, tmux, chatId: '999', now: () => t, refMap: new Map() };
  await tick(deps); assert.equal(tg.actions.length, 1);            // first send
  t += 2000; await tick(deps); assert.equal(tg.actions.length, 1); // within 4s -> suppressed
  t += 3000; await tick(deps); assert.equal(tg.actions.length, 2); // >4s elapsed -> re-sent
});

test('messages from other chat ids are ignored', async () => {
  const bus = makeBus(); const tg = makeTg();
  await handleUpdate({ message: { chat: { id: '111' }, text: '/away' } },
    { bus, tg, tmux: makeTmux(), chatId: '999', refMap: new Map(), now: () => 1 });
  assert.equal(bus.readState().away, false);
  assert.equal(tg.sent.length, 0);
});

test('enrichPermissions converts a permission pending to options from the pane dialog', () => {
  const bus = makeBus([{ ref: 'w1.p', worker: 'w1', paneId: '%1', type: 'permission', text: 'needs permission', options: [], createdAt: 0 }],
    { away: true, workers: { w1: 'sess:%1' } });
  const dialog = 'Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)';
  const tmux = { capturePane: () => dialog, sendKeys() {} };
  enrichPermissions({ bus, tmux });
  const p = bus.readPending('w1.p');
  assert.equal(p.type, 'options');
  assert.equal(p.text, 'Do you want to proceed?');
  assert.deepEqual(p.options, ['Yes', 'No, and tell Claude what to do differently']);
});

test('enrichPermissions falls back to freetext after MAX attempts when no dialog appears', () => {
  const bus = makeBus([{ ref: 'w1.p', worker: 'w1', paneId: '%1', type: 'permission', text: 'needs permission', options: [], createdAt: 0 }],
    { away: true, workers: {} });
  const tmux = { capturePane: () => 'no dialog rendered here', sendKeys() {} };
  for (let i = 0; i < 5; i++) enrichPermissions({ bus, tmux });
  const p = bus.readPending('w1.p');
  assert.equal(p.type, 'freetext');
  assert.match(p.text, /answer at the terminal/);
});

test('isAgentBusy detects a generating pane via "esc to interrupt"', () => {
  assert.equal(isAgentBusy('… thinking (12s) esc to interrupt'), true);
  assert.equal(isAgentBusy('❯\n  idle prompt'), false);
  assert.equal(isAgentBusy(''), false);
  // also busy on the live spinner / shell-run line even without the interrupt hint...
  assert.equal(isAgentBusy('✽ Spelunking… (48s · ↑ 2.0k tokens)'), true);
  assert.equal(isAgentBusy('● Running 1 shell command…'), true);
  // ...but the completed-turn summary (no leading paren before the time) is idle
  assert.equal(isAgentBusy('✻ Baked for 4m 47s'), false);
  // and it reads only the CURRENT bottom, ignoring stale spinner frames up in the byte-log
  const staleHistory = '✽ Composing… (3s · Running 1 shell command · esc to interrupt)\n'
    + Array.from({ length: 20 }, (_, i) => `● committed output line ${i}`).join('\n')
    + '\n✻ Cooked for 16s\n>\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  assert.equal(isAgentBusy(staleHistory), false);
});

test('tick re-nudges the orchestrator while the inbox is non-empty and the pane is idle', async () => {
  const bus = makeBus([], { away: false, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  bus.writeInbox('queued message'); // simulate an undrained inbox
  const tmux = makeTmux(); // capturePane returns 'TAIL' (idle)
  await tick({ bus, tg: makeTg(), tmux, chatId: '999', now: () => 1_000_000, refMap: new Map() });
  assert.equal(tmux.keys.length, 1);
  assert.equal(tmux.keys[0].pane, 'o:%1');
  assert.match(tmux.keys[0].text, /cli\.js inbox/);
});

test('tick rate-limits re-nudges: no second nudge within the window, then one after it', async () => {
  const bus = makeBus([], { away: false, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  bus.writeInbox('queued message');
  const tmux = makeTmux();
  let t = 1_000_000;
  const deps = { bus, tg: makeTg(), tmux, chatId: '999', now: () => t, refMap: new Map() };
  await tick(deps); assert.equal(tmux.keys.length, 1);   // first re-nudge fires
  t += 5_000;  await tick(deps); assert.equal(tmux.keys.length, 1); // within window -> suppressed
  t += 20_000; await tick(deps); assert.equal(tmux.keys.length, 2); // window elapsed -> re-nudge
});

test('tick does NOT re-nudge while the orchestrator pane is busy generating', async () => {
  const bus = makeBus([], { away: false, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  bus.writeInbox('queued message');
  const keys = [];
  const tmux = { keys, sendKeys: (pane, text, opts) => keys.push({ pane, text, enter: opts?.enter !== false }), capturePane: () => 'generating… esc to interrupt' };
  await tick({ bus, tg: makeTg(), tmux, chatId: '999', now: () => 1_000_000, refMap: new Map() });
  assert.equal(keys.length, 0); // busy -> no nudge
});

test('shorten leaves short text alone and truncates long text with an ellipsis', () => {
  assert.equal(shorten('Yes', 60), 'Yes');
  const long = 'Yes, and don\'t ask again for ' + 'x'.repeat(100);
  const out = shorten(long, 60);
  assert.ok(out.length <= 61, 'truncated to ~max');
  assert.ok(out.endsWith('…'));
});

test('buttonsFor returns undefined for freetext', () => {
  assert.equal(buttonsFor({ type: 'freetext', options: [] }), undefined);
});

// FIX B + C tests — written before implementation (TDD)

test('tick collapses an escalated pending answered at the terminal in place — but does NOT touch presence', async () => {
  // No pending on the bus — it was cleared locally. That clearance is NOT an operator signal:
  // orch itself answers/dismisses pendings constantly, and treating that as "operator at the
  // terminal" is what silently re-routed `say` away from the phone (2026-07-14 incident).
  const bus = makeBus([], { away: true, workers: {} });
  const tg = makeTg();
  const refMap = new Map([[5, 'w1.a']]);
  await tick({ bus, tg, chatId: '999', now: () => 1, refMap });
  assert.ok(tg.edits.some(e => e.messageId === 5 && /Resolved at the terminal/.test(e.text)), 'edits the original question in place');
  assert.equal(tg.sent.length, 0, 'no new message — edit in place, no duplicate note');
  assert.equal(refMap.has(5), false, 'refMap entry removed');
  assert.equal(bus.readState().away, true, 'away is UNCHANGED — only genuine typing (presence marker) marks present');
});

test('tick does NOT send terminal note for a still-pending escalated question', async () => {
  const bus = makeBus(
    [{ ref: 'w1.a', worker: 'w1', paneId: '%1', type: 'freetext', text: 'x', options: [], createdAt: 0, escalatedAt: 5, messageId: 5 }],
    { away: true, workers: {} }
  );
  const tg = makeTg();
  const refMap = new Map([[5, 'w1.a']]);
  await tick({ bus, tg, chatId: '999', now: () => 100, refMap });
  assert.ok(!tg.edits.some(e => /Resolved at the terminal/.test(e.text)), 'no resolve-edit for a still-pending question');
});

test('Telegram callback answer does not later trigger a terminal note', async () => {
  const bus = makeBus([{ ref: 'w1.a', worker: 'w1', paneId: '%1', type: 'options', text: 'Deploy?', options: ['Yes', 'No'], createdAt: 0, messageId: 5 }]);
  const tg = makeTg(); const tmux = makeTmux();
  const refMap = new Map([[5, 'w1.a']]);
  // Simulate Telegram callback answer
  await handleUpdate(
    { callback_query: { id: 'c1', data: 'w1.a::0', message: { chat: { id: '999' }, message_id: 5 } } },
    { bus, tg, tmux, chatId: '999', refMap, now: () => 1 }
  );
  // refMap should no longer have the entry
  assert.equal(refMap.has(5), false, 'refMap entry should be removed after callback answer');
  // Subsequent tick should NOT send terminal note
  const tg2 = makeTg();
  await tick({ bus, tg: tg2, chatId: '999', now: () => 2, refMap });
  assert.ok(!tg2.edits.some(e => /Resolved at the terminal/.test(e.text)), 'tick should not misfire after Telegram answer');
});

test('a plain-text Telegram message marks the operator away (so replies reach the phone)', async () => {
  const bus = makeBus([], { away: false, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tmux = makeTmux();
  await handleUpdate({ message: { chat: { id: '999' }, text: 'hi orchestrator' } },
    { bus, tg, tmux, chatId: '999', refMap: new Map(), now: () => 1 });
  assert.equal(bus.readState().away, true);
});


test('deliverReply notifies operator when the pane is gone (no pane, not in workers)', async () => {
  // pending with no paneId and worker not in state.workers
  const bus = makeBus(
    [{ ref: 'w1.a', worker: 'w1', paneId: '', type: 'freetext', text: 'which file?', options: [], createdAt: 0, messageId: 5 }],
    { away: false, workers: {} }
  );
  const tg = makeTg();
  const tmux = makeTmux();
  const refMap = new Map([[5, 'w1.a']]);
  // Use a reply update so deliverReply is called
  await handleUpdate(
    { message: { chat: { id: '999' }, text: 'my answer', reply_to_message: { message_id: 5 } } },
    { bus, tg, tmux, chatId: '999', refMap, now: () => 1 }
  );
  assert.ok(tg.sent.some(m => /pane is gone/.test(m.text)), 'should warn about missing pane');
  assert.equal(bus.readPending('w1.a'), null, 'pending should be removed even when pane is gone');
});

test('spawn-request approve callback spawns via hostClient and clears the pending', async () => {
  const bus = makeBus([{ ref: 'orch.s', worker: 'orch', type: 'spawn-request', proposedName: 'parser', why: 'big', text: 'Spawn worker "parser"? big', createdAt: 0 }]);
  const tg = makeTg();
  const spawned = [];
  await handleUpdate({ callback_query: { id: 'c9', data: 'orch.s::approve', message: { chat: { id: '999' }, message_id: 7 } } },
    { bus, tg, chatId: '999', refMap: new Map([[7, 'orch.s']]), hostClient: { spawn: async (n) => spawned.push(n) }, now: () => 1 });
  assert.deepEqual(spawned, ['parser']);
  assert.equal(bus.readPending('orch.s'), null);
  assert.equal(tg.answered.length, 1);
});

test('spawn-request dismiss callback clears without spawning', async () => {
  const bus = makeBus([{ ref: 'orch.s', worker: 'orch', type: 'spawn-request', proposedName: 'parser', createdAt: 0 }]);
  const tg = makeTg();
  const spawned = [];
  await handleUpdate({ callback_query: { id: 'c9', data: 'orch.s::dismiss', message: { chat: { id: '999' }, message_id: 7 } } },
    { bus, tg, chatId: '999', refMap: new Map(), hostClient: { spawn: async (n) => spawned.push(n) }, now: () => 1 });
  assert.deepEqual(spawned, []);
  assert.equal(bus.readPending('orch.s'), null);
});

test('tick fires a due wall-clock schedule into the orch inbox + nudges', async () => {
  const bus = makeBus([], { away: false, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tmux = makeTmux();
  const schedules = { fireDue: () => [{ id: 'a1', time: '23:03', message: 'ask the operator about the self-improve loop' }] };
  await tick({ bus, tg, tmux, schedules, chatId: '999', now: () => 1000, refMap: new Map() });
  assert.equal(bus._inbox.length, 1);
  assert.match(bus._inbox[0], /23:03.*self-improve loop/);
  assert.equal(tmux.keys.at(-1).pane, 'o:%1'); // orch nudged
});

test('tick renders late-fired and missed schedule entries distinctly in the inbox', async () => {
  const bus = makeBus([], { away: false, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tmux = makeTmux();
  const schedules = { fireDue: () => [
    { id: 'a1', time: '23:03', message: 'nightly check-in', late: true, missedDate: '2026-07-07' },
    { id: 'a2', time: '23:03', message: 'old check-in', missed: true, missedDate: '2026-07-06' },
  ] };
  await tick({ bus, tg, tmux, schedules, chatId: '999', now: () => 1000, refMap: new Map() });
  assert.equal(bus._inbox.length, 2);
  assert.match(bus._inbox[0], /LATE/);
  assert.match(bus._inbox[0], /2026-07-07/);
  assert.match(bus._inbox[0], /nightly check-in/);
  assert.match(bus._inbox[1], /MISSED/);
  assert.match(bus._inbox[1], /NOT auto-run/);
  assert.match(bus._inbox[1], /tell the operator/i);
  assert.equal(tmux.keys.at(-1).pane, 'o:%1'); // orch nudged
});

test('tick auto-flips to AWAY when the cockpit typing heartbeat goes stale', async () => {
  const bus = makeBus([], { away: false, presentAt: 1000, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  const tg = makeTg(); const tmux = makeTmux();
  await tick({ bus, tg, tmux, chatId: '999', now: () => 1000 + 11 * 60000, refMap: new Map() }); // 11 min later
  assert.equal(bus.readState().away, true); // presence expired -> say reaches the phone again
});

test('tick leaves presence alone while the heartbeat is fresh', async () => {
  const bus = makeBus([], { away: false, presentAt: 1000, workers: { orch: 'o:%1' }, orchestratorWorker: 'orch' });
  await tick({ bus, tg: makeTg(), tmux: makeTmux(), chatId: '999', now: () => 1000 + 5 * 60000, refMap: new Map() });
  assert.equal(bus.readState().away, false);
});
