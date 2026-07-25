// test/supervisor-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleUpdate, tick, chunkText, initSupervisorQueue } from '../src/daemon.js';
import { writeRequest, readAnswer, writeRequest as wr } from '../src/approvals.js';

function fakeDeps(over = {}) {
  const state = { workers: {}, ...over.state };
  const sent = [];
  const edited = [];
  const pushed = [];
  return {
    sent, edited, pushed,
    chatId: '1', now: () => 5_000_000, refMap: new Map(),
    bus: {
      readState: () => state,
      writeState: (p) => Object.assign(state, p),
      listPending: () => [], readPending: () => null, updatePending: () => {}, removePending: () => {},
      writeInbox: () => { throw new Error('legacy inbox used in supervisor mode'); },
      inboxCount: () => 0, listOutbox: () => [],
    },
    tg: {
      sendMessage: async (_c, text, opts) => { sent.push({ text, opts }); return sent.length; },
      answerCallback: async () => {}, editMessageText: async (_c, id, text) => { edited.push({ id, text }); },
      sendChatAction: async () => {},
    },
    tmux: { capturePane: () => '', sendKeys: () => {} },
    transcript: { append: () => {} },
    supervisor: { reset: () => {} },
    turnQueue: { push: (label, text) => pushed.push({ label, text }) },
    orchDir: over.orchDir || fs.mkdtempSync(path.join(os.tmpdir(), 'supmode-')),
    ...over,
  };
}

test('plain text goes to the turn queue, not the legacy inbox', async () => {
  const deps = fakeDeps();
  await handleUpdate({ message: { chat: { id: 1 }, text: 'fix the gui' } }, deps);
  assert.deepEqual(deps.pushed, [{ label: 'operator message', text: 'fix the gui' }]);
  assert.equal(deps.bus.readState().away, true); // phone message => away
});

test('/reset rotates the supervisor session', async () => {
  const deps = fakeDeps();
  let reset = false;
  deps.supervisor = { reset: () => { reset = true; } };
  await handleUpdate({ message: { chat: { id: 1 }, text: '/reset' } }, deps);
  assert.equal(reset, true);
  assert.match(deps.sent[0].text, /fresh/i);
});

test('apv:: callback writes the answer file and confirms', async () => {
  const deps = fakeDeps();
  const req = writeRequest(deps.orchDir, { toolName: 'Bash', input: { command: 'git push' }, now: () => 1000 });
  await handleUpdate({ callback_query: { id: 'cb', data: `apv::${req.id}::allow`, message: { chat: { id: 1 }, message_id: 9 } } }, deps);
  assert.equal(readAnswer(deps.orchDir, req.id).allow, true);
  assert.match(deps.edited[0].text, /Allowed/);
});

test('a LATE allow (after the MCP wait window) queues an approval turn', async () => {
  const deps = fakeDeps();
  const req = writeRequest(deps.orchDir, { toolName: 'Bash', input: { command: 'git push' }, now: () => 1000 });
  deps.now = () => 1000 + 10 * 60_000; // 10 min later — far past APPROVAL_WAIT_MS
  await handleUpdate({ callback_query: { id: 'cb', data: `apv::${req.id}::allow`, message: { chat: { id: 1 }, message_id: 9 } } }, deps);
  assert.equal(deps.pushed.length, 1);
  assert.equal(deps.pushed[0].label, 'approval');
  assert.match(deps.pushed[0].text, /APPROVED/);
  assert.match(deps.pushed[0].text, /git push/);
});

test('a stray apv:: tap on a legacy daemon is consumed without crashing', async () => {
  const deps = fakeDeps();
  delete deps.supervisor;
  delete deps.turnQueue;
  deps.orchDir = undefined; // legacy daemon: no approvals state dir at all
  const acked = [];
  deps.tg.answerCallback = async (id, note) => { acked.push({ id, note }); };
  await handleUpdate({ callback_query: { id: 'cb', data: 'apv::x::allow', message: { chat: { id: 1 }, message_id: 9 } } }, deps);
  assert.equal(acked.length, 1, 'callback acked so Telegram stops redelivering');
});

test('a double late-Allow pushes exactly ONE approval turn', async () => {
  const deps = fakeDeps();
  const req = writeRequest(deps.orchDir, { toolName: 'Bash', input: { command: 'git push' }, now: () => 1000 });
  deps.now = () => 1000 + 10 * 60_000; // far past APPROVAL_WAIT_MS
  const cb = { callback_query: { id: 'cb', data: `apv::${req.id}::allow`, message: { chat: { id: 1 }, message_id: 9 } } };
  await handleUpdate(cb, deps);
  await handleUpdate(cb, deps); // double-tap / Telegram redelivery
  assert.equal(deps.pushed.length, 1, 'the proceed turn fires at most once');
});

test('a late DENY never pushes an approval turn', async () => {
  const deps = fakeDeps();
  const req = writeRequest(deps.orchDir, { toolName: 'Bash', input: { command: 'git push' }, now: () => 1000 });
  deps.now = () => 1000 + 10 * 60_000; // far past APPROVAL_WAIT_MS
  await handleUpdate({ callback_query: { id: 'cb', data: `apv::${req.id}::deny`, message: { chat: { id: 1 }, message_id: 9 } } }, deps);
  assert.equal(deps.pushed.length, 0, 'deny must never queue a proceed turn');
  assert.equal(readAnswer(deps.orchDir, req.id).allow, false);
});

test('malformed apv:: data is acked and ignored', async () => {
  const deps = fakeDeps();
  await handleUpdate({ callback_query: { id: 'cb', data: 'apv::', message: { chat: { id: 1 }, message_id: 9 } } }, deps);
  let names = [];
  try { names = fs.readdirSync(path.join(deps.orchDir, 'approvals')); } catch { names = []; }
  assert.deepEqual(names.filter((n) => n.startsWith('ans-')), [], 'no answer file written for an empty id');
  assert.equal(deps.pushed.length, 0);
});

function tickDeps(over = {}) {
  const d = fakeDeps(over);
  d.schedules = null;
  return d;
}

test('chunkText splits at the Telegram cap and never returns empty', () => {
  assert.deepEqual(chunkText('', 10), ['(empty reply)']);
  const parts = chunkText('a'.repeat(25), 10);
  assert.deepEqual(parts, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
});

test('watchdog alerts become turns; schedules go to the queue, not the inbox', async () => {
  const deps = tickDeps();
  deps.watchdog = async () => ['WATCHDOG: GUI check "gui-host-api" failing'];
  deps.schedules = { fireDue: () => [{ time: '09:00', message: 'morning check' }] };
  await tick(deps);
  const labels = deps.pushed.map((p) => p.label);
  assert.ok(labels.includes('watchdog'));
  assert.ok(labels.includes('schedule'));
});

test('an escalated worker pending routes to the queue in supervisor mode', async () => {
  const deps = tickDeps();
  const pend = [{ ref: 'p1', worker: 'Worker1', type: 'freetext', text: 'which format?', createdAt: 0 }];
  deps.bus.listPending = () => pend;
  deps.bus.readPending = (ref) => pend.find((p) => p.ref === ref) || null;
  deps.bus.readState = () => ({ away: true, workers: { Worker1: 'Worker1' } });
  await tick(deps);
  assert.equal(deps.pushed.length, 1);
  assert.equal(deps.pushed[0].label, 'worker');
  assert.match(deps.pushed[0].text, /Worker1/);
  assert.match(deps.pushed[0].text, /which format\?/);
});

test('unmessaged approval requests get a Telegram message with Allow/Deny buttons', async () => {
  const deps = tickDeps();
  wr(deps.orchDir, { toolName: 'Bash', input: { command: 'git push' }, now: () => 4_999_000 });
  await tick(deps);
  const msg = deps.sent.find((s) => /wants to run/i.test(s.text));
  assert.ok(msg);
  assert.match(JSON.stringify(msg.opts.buttons), /apv::/);
});

test('initSupervisorQueue sends the reply back to Telegram in chunks', async () => {
  const deps = tickDeps();
  deps.supervisor = { ask: async () => ({ reply: 'done: all healthy' }) };
  const q = initSupervisorQueue(deps);
  q.push('operator message', 'status?');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(deps.sent.some((s) => /all healthy/.test(s.text)));
});

test('a delivery failure retries the send, never the turn', async () => {
  const deps = tickDeps();
  let asks = 0;
  deps.supervisor = { ask: async () => { asks += 1; return { reply: 'r' }; } };
  deps.tg.sendMessage = async () => { throw new Error('net'); };
  deps._retrySendDelayMs = 1;
  const q = initSupervisorQueue(deps);
  q.push('operator message', 'x');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(asks, 1, 'the turn must run exactly once — delivery failures never re-run it');
});

test('an approval send failure does not abort the tick', async () => {
  const deps = tickDeps();
  wr(deps.orchDir, { toolName: 'Bash', input: { command: 'git push' }, now: () => 4_999_000 });
  const goodSend = deps.tg.sendMessage;
  deps.tg.sendMessage = async () => { throw new Error('net down'); };
  await tick(deps); // must resolve, not reject, despite the send failure
  assert.equal(deps.sent.length, 0, 'nothing delivered while Telegram is down');
  deps.tg.sendMessage = goodSend; // Telegram heals
  await tick(deps);
  const msg = deps.sent.find((s) => /wants to run/i.test(s.text));
  assert.ok(msg, 'the approval message goes out once the channel recovers');
  assert.match(JSON.stringify(msg.opts.buttons), /apv::/);
});

// --- streak-rotation tests (TDD: RED first, then the fix in daemon.js makes them green) ---

test('two consecutive onError events call supervisor.reset once and mention fresh session', async () => {
  const deps = tickDeps();
  let resets = 0;
  deps.supervisor = { ask: async () => { throw new Error('timeout'); }, reset: () => { resets++; } };
  const q = initSupervisorQueue(deps);
  // First failure batch: streak → 1, no reset yet
  q.push('operator message', 'first');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resets, 0, 'no reset after first failure');
  // Second failure batch: streak → 2, reset fires
  q.push('operator message', 'second');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resets, 1, 'reset called exactly once after second consecutive failure');
  // The operator message for the second event must explain the rotation
  const lastSent = deps.sent[deps.sent.length - 1];
  assert.ok(lastSent, 'an operator message was sent');
  assert.match(lastSent.text, /fresh|rotat/i, 'message must mention fresh session or rotation');
});

test('failure then success then failure does NOT call supervisor.reset (streak resets on success)', async () => {
  const deps = tickDeps();
  let resets = 0;
  let shouldFail = true;
  deps.supervisor = {
    ask: async () => {
      if (shouldFail) throw new Error('timeout');
      return { reply: 'ok' };
    },
    reset: () => { resets++; },
  };
  const q = initSupervisorQueue(deps);
  // First failure: streak → 1
  q.push('operator message', 'fail1');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resets, 0);
  // Success: streak resets to 0
  shouldFail = false;
  q.push('operator message', 'succeed');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resets, 0);
  // Second failure: streak → 1 again (not 2), so no reset
  shouldFail = true;
  q.push('operator message', 'fail2');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resets, 0, 'streak was broken by success — second failure alone must not trigger reset');
});
