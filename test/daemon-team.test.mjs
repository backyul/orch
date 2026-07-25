// test/daemon-team.test.mjs
// Hermetic tests for Task 6: worker-tagged approvals routed to the supervisor turn queue,
// escalated worker approvals going to Telegram. All in-memory/temp-dir fakes, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepApprovals, handleUpdate, sweepTeam } from '../src/daemon.js';
import { writeRequest, listRequests, updateRequest } from '../src/approvals.js';
import { APPROVAL_WAIT_MS } from '../src/config.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dteam-')); }

// Minimal deps that satisfy sweepApprovals:
//   - deps.supervisor truthy (guard to enter sweepApprovals)
//   - deps.orchDir (the state dir)
//   - deps.now
//   - deps.tg.sendMessage (called by sendAndLog; must return a messageId value)
//   - deps.chatId (sendAndLog arg)
//   - deps.turnQueue.push (new worker-routing branch)
// mirror() in sendAndLog accesses deps.transcript (optional — it swallows errors).
function fakeDeps(dir) {
  const pushed = [];
  const sent = [];
  return {
    orchDir: dir,
    supervisor: {},         // truthy: sweepApprovals guard passes
    now: () => Date.now(),
    turnQueue: { push: (label, text) => pushed.push({ label, text }) },
    tg: { sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return sent.length; } },
    chatId: '1',
    pushed,
    sent,
  };
}

test('worker-tagged approval becomes ONE supervisor turn, not a Telegram message', async () => {
  const dir = tmp();
  const deps = fakeDeps(dir);
  writeRequest(dir, { toolName: 'Bash', input: { command: 'npm i left-pad' }, worker: 'alpha' });
  await sweepApprovals(deps);
  await sweepApprovals(deps);                       // second sweep must not re-notify
  assert.equal(deps.pushed.length, 1);
  assert.match(deps.pushed[0].text, /alpha/);
  assert.match(deps.pushed[0].text, /team-approve/);
  assert.match(deps.pushed[0].text, /team-escalate/);
  assert.equal(listRequests(dir)[0].messageId, undefined);  // nothing sent to the phone
});

test('an escalated worker approval goes to Telegram like a supervisor approval', async () => {
  const dir = tmp();
  const deps = fakeDeps(dir);
  let sentMsg = null;
  deps.tg = { sendMessage: async (chat, text, extra) => { sentMsg = { text, extra }; return { message_id: 7 }; } };
  const r = writeRequest(dir, { toolName: 'Bash', input: { command: 'schtasks /delete' }, worker: 'alpha' });
  updateRequest(dir, r.id, { escalated: true });
  await sweepApprovals(deps);
  assert.ok(sentMsg && /alpha/.test(sentMsg.text)); // phone message names the worker
  assert.equal(deps.pushed.length, 0);
});

test('a supervisorNotified worker request escalated AFTER still raises the phone buttons', async () => {
  const dir = tmp();
  const deps = fakeDeps(dir);
  const r = writeRequest(dir, { toolName: 'Bash', input: { command: 'rm -rf build' }, worker: 'alpha' });
  updateRequest(dir, r.id, { supervisorNotified: true });   // supervisor already saw it...
  updateRequest(dir, r.id, { escalated: true });            // ...then chose team-escalate
  await sweepApprovals(deps);
  assert.equal(deps.pushed.length, 0, 'no second supervisor turn');
  assert.equal(deps.sent.length, 1, 'phone message sent');
  assert.match(deps.sent[0].text, /Worker "alpha"/);
  assert.ok(deps.sent[0].opts.buttons, 'Allow/Deny buttons present');
});

test('late phone-approval of an ESCALATED worker request requeues the WORKER, not the supervisor', async () => {
  const dir = tmp();
  const deps = fakeDeps(dir);
  const calls = [];
  deps.team = { sendToWorker: (n, m) => calls.push([n, m]) };
  deps.refMap = new Map();
  deps.bus = { writeState: () => {}, readState: () => ({}), readPending: () => null };
  deps.tg = { sendMessage: async () => 1, answerCallback: async () => {}, editMessageText: async () => {} };
  // Request older than the wait window: the worker's MCP turn already returned PENDING.
  const r = writeRequest(dir, { toolName: 'Bash', input: { command: 'npm publish' }, worker: 'alpha',
    now: () => Date.now() - APPROVAL_WAIT_MS - 60_000 });
  updateRequest(dir, r.id, { escalated: true });
  await handleUpdate(
    { callback_query: { id: 'c1', data: `apv::${r.id}::allow`, message: { chat: { id: '1' }, message_id: 5 } } },
    deps);
  assert.equal(calls.length, 1, 'worker requeued exactly once');
  assert.equal(calls[0][0], 'alpha');
  assert.match(calls[0][1], /APPROVED/);
  assert.match(calls[0][1], /retry/i);
  assert.equal(deps.pushed.length, 0, 'no "Proceed with it now" turn for an action the supervisor never requested');
});

// ── Task 7: sweepTeam ──────────────────────────────────────────────────────

function fakeTeam(workers, runImpl) {
  return {
    listWorkers: () => workers,
    runTurn: runImpl,
    markError: (name, msg) => { const w = workers.find((x) => x.name === name); if (w) { w.status = 'error'; w.lastError = msg; } },
  };
}

test('sweepTeam advances active workers concurrently but never more than 3 in flight', async () => {
  const dir = tmp();
  const deps = fakeDeps(dir);
  let inFlight = 0, maxInFlight = 0;
  const workers = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, status: 'active' }));
  deps.team = fakeTeam(workers, async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return { worker: {}, reply: 'ok', events: [] };
  });
  await sweepTeam(deps);                       // launches ≤3, returns without awaiting them
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(maxInFlight <= 3, `max in flight was ${maxInFlight}`);
});

test('digest/done/blocked/paused events become supervisor turns naming the worker', async () => {
  const dir = tmp();
  const deps = fakeDeps(dir);
  deps.team = fakeTeam([{ name: 'a', status: 'active' }], async () => ({
    worker: { name: 'a', status: 'done', branch: 'team/a', turnCount: 7 },
    reply: 'DONE: merged-ready', events: [{ type: 'done' }],
  }));
  await sweepTeam(deps);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(deps.pushed.length, 1);
  assert.match(deps.pushed[0].text, /"a"/);
  assert.match(deps.pushed[0].text, /DONE: merged-ready/);
  assert.match(deps.pushed[0].text, /team\/a/);          // branch named for review/merge
});

test('a worker turn failure retries next sweep; second failure marks error + one supervisor turn', async () => {
  const dir = tmp();
  const deps = fakeDeps(dir);
  const workers = [{ name: 'a', status: 'active' }];
  deps.team = fakeTeam(workers, async () => { throw new Error('turn exploded'); });
  await sweepTeam(deps); await new Promise((r) => setTimeout(r, 10));
  assert.equal(deps.pushed.length, 0);                    // first failure: silent retry
  assert.equal(workers[0].status, 'active');
  await sweepTeam(deps); await new Promise((r) => setTimeout(r, 10));
  assert.equal(workers[0].status, 'error');
  assert.equal(deps.pushed.length, 1);
  assert.match(deps.pushed[0].text, /turn exploded/);
});

test('a worker already in flight is not double-launched', async () => {
  const dir = tmp();
  const deps = fakeDeps(dir);
  let calls = 0;
  deps.team = fakeTeam([{ name: 'a', status: 'active' }], async () => {
    calls++; await new Promise((r) => setTimeout(r, 40));
    return { worker: {}, reply: 'ok', events: [] };
  });
  await sweepTeam(deps);
  await sweepTeam(deps);                                  // second sweep while turn 1 runs
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1);
});

test('two-strike RESET: a success between failures resets the count so error fires only on two CONSECUTIVE failures', async () => {
  // Regression lock: deps._teamFails.delete(w.name) in the .then path must reset the counter.
  // Pattern: fail, succeed, fail (no error), fail, fail (error fires on the second consecutive fail).
  const dir = tmp();
  const deps = fakeDeps(dir);
  const workers = [{ name: 'a', status: 'active' }];
  let callCount = 0;
  // Mutable impl reference: swap what runTurn does between sweeps.
  let impl = async () => { throw new Error('boom'); };
  deps.team = fakeTeam(workers, async (...args) => impl(...args));

  // Turn 1: fail (strike 1)
  await sweepTeam(deps); await new Promise((r) => setTimeout(r, 10));
  assert.equal(deps.pushed.length, 0, 'no error after strike 1');
  assert.equal(workers[0].status, 'active');

  // Turn 2: succeed — must reset the strike count
  impl = async () => { callCount++; return { worker: { name: 'a' }, reply: 'ok', events: [] }; };
  await sweepTeam(deps); await new Promise((r) => setTimeout(r, 10));
  assert.equal(deps.pushed.length, 0, 'no error after success');
  assert.equal(workers[0].status, 'active');

  // Turn 3: fail again (strike 1 of a NEW sequence — reset means we start over)
  impl = async () => { throw new Error('boom2'); };
  await sweepTeam(deps); await new Promise((r) => setTimeout(r, 10));
  assert.equal(deps.pushed.length, 0, 'no error: success reset the counter so this is only strike 1 again');
  assert.equal(workers[0].status, 'active');

  // Turn 4: fail again (strike 2 of consecutive sequence → error fires now)
  await sweepTeam(deps); await new Promise((r) => setTimeout(r, 10));
  assert.equal(workers[0].status, 'error', 'two consecutive failures → error');
  assert.equal(deps.pushed.length, 1, 'exactly one error supervisor turn');
  assert.match(deps.pushed[0].text, /boom2/);
});
