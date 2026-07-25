import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleHookEvent, extractTail } from '../src/orc-signal.js';

function fakeBus() {
  const pending = [];
  return {
    pending,
    genRef: (w) => `${w}.ref1`,
    listPending: () => pending.slice(),
    writePending: (rec) => { pending.push(rec); return rec; },
    removePending: (ref) => { const i = pending.findIndex((p) => p.ref === ref); if (i >= 0) pending.splice(i, 1); },
  };
}
function fakeRegistry({ role = 'worker', cap = '' } = {}) {
  const sids = [];
  return {
    sids,
    get: (n) => ({ name: n, role }),
    capture: () => cap,
    setSessionId: (n, sid) => { const changed = sids[sids.length - 1] !== sid; sids.push(sid); return { changed }; },
  };
}

test('worker idle_prompt writes a freetext pending that the daemon can triage', () => {
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'worker', cap: 'Want me to continue in order, or jump?' });
  const out = handleHookEvent({ bus, registry, now: () => 1000 }, {
    name: 'Worker1', event: 'Notification', notificationType: 'idle_prompt', sessionId: 's1',
  });
  assert.equal(out.signaled, true);
  assert.equal(bus.pending.length, 1);
  assert.equal(bus.pending[0].worker, 'Worker1');
  assert.equal(bus.pending[0].type, 'freetext');
  assert.match(bus.pending[0].text, /continue in order, or jump/);
  assert.equal(bus.pending[0].createdAt, 1000);
});

test('a worker Stop hook (turn ended) signals when the pane shows a question', () => {
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'worker', cap: 'Done. Which series next — 001 or 002?' });
  const out = handleHookEvent({ bus, registry, now: () => 1000 }, {
    name: 'Worker1', event: 'Stop', sessionId: 's1',
  });
  assert.equal(out.signaled, true);
  assert.equal(bus.pending.length, 1);
  assert.equal(bus.pending[0].worker, 'Worker1');
  assert.match(bus.pending[0].text, /001 or 002/); // carries the captured question
});

test('a worker Stop while RESTING at an empty prompt does NOT signal (finished a task, no question)', () => {
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'worker', cap: '● Done. Migrated all 111 files.\n>\n  ? for shortcuts' });
  const out = handleHookEvent({ bus, registry, now: () => 1000 }, {
    name: 'Worker1', event: 'Stop', sessionId: 's1',
  });
  assert.equal(out.signaled, false); // turn ended, but the worker is resting — not blocked
  assert.equal(bus.pending.length, 0);
});

test('a worker Stop with a selector/permission dialog on the pane signals (blocked)', () => {
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'worker', cap: 'Grant Bash permission?\n❯ 1. Yes\n  2. No, and tell Claude what to do' });
  const out = handleHookEvent({ bus, registry, now: () => 1000 }, {
    name: 'Worker1', event: 'Stop', sessionId: 's1',
  });
  assert.equal(out.signaled, true);
  assert.equal(bus.pending.length, 1);
});

test('idle_prompt Notification ALWAYS signals, even when the pane shows no question', () => {
  // Claude itself reporting it is waiting is trustworthy — it bypasses the pane heuristic.
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'worker', cap: 'still churning, no visible question' });
  const out = handleHookEvent({ bus, registry, now: () => 1000 }, {
    name: 'Worker1', event: 'Notification', notificationType: 'idle_prompt', sessionId: 's1',
  });
  assert.equal(out.signaled, true);
  assert.equal(bus.pending.length, 1);
});

test('the orchestrator Stop does NOT create a pending (only self-heals)', () => {
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'orchestrator' });
  const out = handleHookEvent({ bus, registry }, { name: 'orch', event: 'Stop', sessionId: 's9' });
  assert.equal(out.signaled, false);
  assert.equal(bus.pending.length, 0);
});

test('the orchestrator idle does NOT create a pending (it waits on the operator inbox)', () => {
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'orchestrator' });
  const out = handleHookEvent({ bus, registry }, {
    name: 'orch', event: 'Notification', notificationType: 'idle_prompt', sessionId: 's1',
  });
  assert.equal(out.signaled, false);
  assert.equal(bus.pending.length, 0);
});

test('a second idle for the same worker is deduped (one outstanding pending)', () => {
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'worker', cap: 'x' });
  const p = { name: 'Worker1', event: 'Notification', notificationType: 'idle_prompt', sessionId: 's1' };
  handleHookEvent({ bus, registry }, p);
  const out2 = handleHookEvent({ bus, registry }, p);
  assert.equal(out2.signaled, false);
  assert.equal(bus.pending.length, 1);
});

test('a non-signal notification type (e.g. auth_success) does not signal', () => {
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'worker' });
  const out = handleHookEvent({ bus, registry }, {
    name: 'Worker1', event: 'Notification', notificationType: 'auth_success', sessionId: 's1',
  });
  assert.equal(out.signaled, false);
  assert.equal(bus.pending.length, 0);
});

test('self-heal: a changed session id refreshes the stored id even with no signal', () => {
  const bus = fakeBus();
  const registry = fakeRegistry({ role: 'orchestrator' });
  const out = handleHookEvent({ bus, registry }, {
    name: 'orch', event: 'SessionStart', source: 'compact', sessionId: 's-new',
  });
  assert.equal(out.selfHealed, true);
  assert.deepEqual(registry.sids, ['s-new']);
});

test('unknown agent is ignored (no throw, no pending)', () => {
  const bus = fakeBus();
  const registry = { get: () => null };
  const out = handleHookEvent({ bus, registry }, { name: 'ghost', event: 'Notification', notificationType: 'idle_prompt' });
  assert.equal(out.signaled, false);
  assert.equal(out.selfHealed, false);
  assert.equal(bus.pending.length, 0);
});

test('extractTail strips ANSI and returns the last non-blank lines', () => {
  const raw = 'line one\n\x1b[38;2;153;153;153mdim question?\x1b[m\n\n';
  const tail = extractTail(raw, { maxLines: 5 });
  assert.equal(tail, 'line one\ndim question?');
});
