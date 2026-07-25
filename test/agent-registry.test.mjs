import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/agent-registry.js';

// A controllable fake PTY. emit() lets the test simulate agent output/exit.
function makeFakePtyFactory(log = []) {
  const ptys = new Map();
  const factory = (name, opts) => {
    let dataCb = () => {}, exitCb = () => {};
    const pty = {
      pid: 1000 + ptys.size,
      written: [],
      opts,
      write(s) { this.written.push(s); },
      resize(c, r) { this.resized = [c, r]; },
      onData(cb) { dataCb = cb; },
      onExit(cb) { exitCb = cb; },
      kill() { log.push(['kill', name]); exitCb({ exitCode: 0 }); },
      _emitData(s) { dataCb(s); },
      _emitExit(code) { exitCb({ exitCode: code }); },
    };
    ptys.set(name, pty);
    log.push(['spawn', name, opts]);
    return pty;
  };
  factory.get = (name) => ptys.get(name);
  return factory;
}

const memStore = () => { let v = []; return { load: () => v, save: (x) => { v = x; } }; };

test('spawn registers a running agent and persists the manifest', () => {
  const store = memStore();
  const reg = createRegistry({ ptyFactory: makeFakePtyFactory(), store });
  reg.spawn('worker1');
  assert.equal(reg.list()[0].name, 'worker1');
  assert.equal(reg.list()[0].status, 'running');
  assert.equal(store.load()[0].name, 'worker1');
});

test('setSessionId refreshes the stored session id and persists (self-heal)', () => {
  const store = memStore();
  const reg = createRegistry({ ptyFactory: makeFakePtyFactory(), store });
  reg.spawn('worker1', { sessionId: 'old', resume: true });
  const r = reg.setSessionId('worker1', 'new');
  assert.equal(r.changed, true);
  assert.equal(reg.get('worker1').sessionId, 'new');
  assert.equal(store.load()[0].sessionId, 'new'); // persisted for --resume on restart
  assert.equal(reg.setSessionId('worker1', 'new').changed, false); // unchanged -> no-op
  assert.equal(reg.setSessionId('ghost', 'x').changed, false);     // unknown -> no throw
});

test('rename moves the agent to a new name, resuming the same session', () => {
  const log = [];
  const factory = makeFakePtyFactory(log);
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  const orig = reg.spawn('orch', { persona: 'p' });
  reg.rename('orch', 'boss');
  assert.equal(reg.get('orch'), null);
  assert.equal(reg.get('boss').status, 'running');
  const renameSpawn = log.filter((e) => e[0] === 'spawn' && e[1] === 'boss')[0];
  assert.equal(renameSpawn[2].sessionId, orig.sessionId); // same session resumed under the new name
  assert.equal(renameSpawn[2].resume, true);
  assert.equal(reg.get('boss').persona, 'p');
});

test('resize forwards cols/rows to that agent PTY', () => {
  const factory = makeFakePtyFactory();
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  reg.resize('worker1', 120, 40);
  assert.deepEqual(factory.get('worker1').resized, [120, 40]);
});

test('restart sizes the new PTY to the last known terminal size (no shrink)', () => {
  const factory = makeFakePtyFactory();
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  reg.resize('worker1', 100, 40);
  reg.restart('worker1');
  assert.deepEqual(factory.get('worker1').resized, [100, 40]); // new PTY matches the pane
});

test('send writes the text to that agent PTY', () => {
  const factory = makeFakePtyFactory();
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  reg.send('worker1', 'do X');
  assert.deepEqual(factory.get('worker1').written, ['do X']);
});

test('agent output is captured into the ring buffer', () => {
  const factory = makeFakePtyFactory();
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  factory.get('worker1')._emitData('hello from worker');
  assert.match(reg.capture('worker1'), /hello from worker/);
});

test('capture/send on an unknown agent throws a clear error', () => {
  const reg = createRegistry({ ptyFactory: makeFakePtyFactory(), store: memStore() });
  assert.throws(() => reg.send('ghost', 'hi'), /unknown agent: ghost/);
  assert.throws(() => reg.capture('ghost'), /unknown agent: ghost/);
});

test('kill marks the agent exited but keeps the slot', () => {
  const factory = makeFakePtyFactory();
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  reg.kill('worker1');
  assert.equal(reg.get('worker1').status, 'exited');     // slot preserved, not deleted
});

test('remove deletes the agent entirely (gone from the list, pty killed)', () => {
  const log = [];
  const factory = makeFakePtyFactory(log);
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  reg.remove('worker1');
  assert.equal(reg.get('worker1'), null);                       // gone, not just exited
  assert.ok(!reg.list().some((a) => a.name === 'worker1'));
  assert.ok(log.some(([op, n]) => op === 'kill' && n === 'worker1')); // pty was killed
});

test('remove refuses to delete the orchestrator', () => {
  const reg = createRegistry({ ptyFactory: makeFakePtyFactory(), store: memStore() });
  reg.spawn('orch'); // name 'orch' -> role orchestrator
  assert.throws(() => reg.remove('orch'), /orchestrator/);
  assert.equal(reg.get('orch').status, 'running'); // still present, untouched
});

test('unexpected PTY exit flips status to exited with the code', () => {
  const factory = makeFakePtyFactory();
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  factory.get('worker1')._emitExit(1);
  assert.equal(reg.get('worker1').status, 'exited');
  assert.equal(reg.get('worker1').exitCode, 1);
});

test('restart spawns a new PTY for the slot and returns running', () => {
  const factory = makeFakePtyFactory();
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  reg.kill('worker1');
  const snap = reg.restart('worker1');
  assert.equal(snap.status, 'running');
});

test('resumeAll re-spawns each manifest entry with its sessionId', () => {
  const log = [];
  const factory = makeFakePtyFactory(log);
  const store = { load: () => [{ name: 'orch', sessionId: 'sid-1', status: 'running' }], save() {} };
  const reg = createRegistry({ ptyFactory: factory, store });
  reg.resumeAll();
  const spawnCall = log.find((e) => e[0] === 'spawn' && e[1] === 'orch');
  assert.ok(spawnCall, 'orch was spawned');
  assert.equal(spawnCall[2].sessionId, 'sid-1');
  assert.equal(spawnCall[2].resume, true);
});

test('fresh spawn assigns a sessionId so the manifest is resumable', () => {
  const reg = createRegistry({ ptyFactory: makeFakePtyFactory(), store: memStore() });
  const snap = reg.spawn('worker1');
  assert.match(snap.sessionId, /[0-9a-f-]{36}/); // a UUID
});

test('spawn persists persona + role and passes persona to the factory', () => {
  const log = [];
  const factory = makeFakePtyFactory(log);
  const store = memStore();
  const reg = createRegistry({ ptyFactory: factory, store });
  reg.spawn('w1', { persona: 'Backend specialist.' });
  const spawnCall = log.find((e) => e[0] === 'spawn' && e[1] === 'w1');
  assert.equal(spawnCall[2].persona, 'Backend specialist.');
  assert.equal(store.load()[0].persona, 'Backend specialist.');
  assert.equal(store.load()[0].role, 'worker');
});

test('restart preserves the stored persona when none is supplied', () => {
  const log = [];
  const factory = makeFakePtyFactory(log);
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('w1', { persona: 'keep me' });
  reg.restart('w1');
  const last = log.filter((e) => e[0] === 'spawn' && e[1] === 'w1').pop();
  assert.equal(last[2].persona, 'keep me');
});

test('a resumed agent that dies immediately retries once as a fresh agent', () => {
  const log = [];
  const factory = makeFakePtyFactory(log);
  let t = 1000;
  const reg = createRegistry({ ptyFactory: factory, store: memStore(), now: () => t });
  reg.spawn('orch', { sessionId: 'old-sid', resume: true });
  const doomed = factory.get('orch'); // the resumed PTY that can't load its session
  t = 2500;                            // 1.5s later — within the retry window
  doomed._emitExit(1);                 // "No conversation found" -> non-zero exit
  const spawns = log.filter((e) => e[0] === 'spawn' && e[1] === 'orch');
  assert.equal(spawns.length, 2);            // original + one fresh retry
  assert.equal(spawns[1][2].resume, false);  // retry is a fresh session, not a resume
  assert.equal(reg.get('orch').status, 'running');
});

test('resume failure detected by output retries even after the time window', () => {
  const log = [];
  const factory = makeFakePtyFactory(log);
  let t = 1000;
  const reg = createRegistry({ ptyFactory: factory, store: memStore(), now: () => t });
  reg.spawn('orch', { sessionId: 'sid', resume: true });
  const p = factory.get('orch');
  p._emitData('No conversation found with session ID: sid'); // claude's resume-failure message
  t = 20000;          // 19s later — well past the quick-exit window
  p._emitExit(1);
  const spawns = log.filter((e) => e[0] === 'spawn' && e[1] === 'orch');
  assert.equal(spawns.length, 2);           // retried because of the error string, not timing
  assert.equal(spawns[1][2].resume, false); // fresh
});

test('kill emits exactly one status event (a late onExit is gated by the dead flag)', () => {
  const factory = makeFakePtyFactory();
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  const statusEvents = [];
  reg.subscribe((e) => { if (e.type === 'status') statusEvents.push(e); });
  reg.kill('worker1'); // fake pty.kill() synchronously fires onExit — must NOT double-emit
  assert.equal(statusEvents.length, 1);
});

test('resumeAll skips agents that were exited at shutdown', () => {
  const log = [];
  const factory = makeFakePtyFactory(log);
  const store = { load: () => [
    { name: 'orch', sessionId: 's1', status: 'running' },
    { name: 'gone', sessionId: 's2', status: 'exited' },
  ], save() {} };
  const reg = createRegistry({ ptyFactory: factory, store });
  reg.resumeAll();
  assert.ok(log.find((e) => e[0] === 'spawn' && e[1] === 'orch'), 'running agent resumed');
  assert.ok(!log.find((e) => e[0] === 'spawn' && e[1] === 'gone'), 'exited agent not revived');
});

test('a superseded PTY\'s late exit does not emit for the new same-named agent', () => {
  const factory = makeFakePtyFactory();
  const reg = createRegistry({ ptyFactory: factory, store: memStore() });
  reg.spawn('worker1');
  const oldPty = factory.get('worker1');
  reg.kill('worker1');
  reg.restart('worker1'); // a fresh PTY now occupies the 'worker1' slot
  const events = [];
  reg.subscribe((e) => events.push(e));
  oldPty._emitExit(0); // late exit from the dead old PTY
  assert.equal(events.filter((e) => e.type === 'status').length, 0);
});

test('setPersona updates the stored persona without touching the live PTY', () => {
  const store = memStore();
  const log = [];
  const reg = createRegistry({ ptyFactory: makeFakePtyFactory(log), store });
  reg.spawn('orch', { persona: 'old rules' });
  const r = reg.setPersona('orch', 'new rules');
  assert.equal(r.changed, true);
  assert.equal(store.load()[0].persona, 'new rules');           // persisted for the next resume
  assert.equal(log.filter(([op]) => op === 'kill').length, 0);  // live agent untouched
  assert.equal(reg.setPersona('orch', 'new rules').changed, false); // same text -> no-op
  assert.equal(reg.setPersona('ghost', 'x').changed, false);        // unknown -> no throw
});
