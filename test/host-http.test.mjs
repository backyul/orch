import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostHandler } from '../src/host-http.js';

function fakeReg() {
  const calls = [];
  return {
    calls,
    spawn: (n) => { calls.push(['spawn', n]); return { name: n, status: 'running' }; },
    kill: (n) => { calls.push(['kill', n]); return { name: n, status: 'exited' }; },
    remove: (n) => { calls.push(['remove', n]); return { name: n, removed: true }; },
    get: (n) => ({ name: n, role: n === 'orch' ? 'orchestrator' : 'worker' }),
    restart: (n) => { calls.push(['restart', n]); return { name: n, status: 'running' }; },
    send: (n, t) => { calls.push(['send', n, t]); return true; },
    capture: (n) => `cap:${n}`,
    setSessionId: (n, sid) => { calls.push(['setSessionId', n, sid]); return { changed: true }; },
    list: () => [{ name: 'orch', status: 'running' }],
  };
}

function fakeBusWithPending(pending) {
  return {
    listPending: () => pending.slice(),
    writePending: (rec) => { pending.push(rec); return rec; },
    removePending: (ref) => { const i = pending.findIndex((p) => p.ref === ref); if (i >= 0) pending.splice(i, 1); },
    genRef: (w) => `${w}.r1`,
  };
}

function reqres(method, url, body) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = { method, url, on(ev, cb) { if (ev === 'data') chunks.forEach(cb); if (ev === 'end') cb(); } };
  const res = { statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; }, writeHead(c) { this.statusCode = c; },
    end(s) { this.body = s || ''; } };
  return { req, res };
}

test('GET /api/agents returns the list', async () => {
  const reg = fakeReg();
  const { req, res } = reqres('GET', '/api/agents');
  await createHostHandler(reg)(req, res);
  assert.deepEqual(JSON.parse(res.body), [{ name: 'orch', status: 'running' }]);
});

test('POST /api/spawn calls registry.spawn with the name', async () => {
  const reg = fakeReg();
  const { req, res } = reqres('POST', '/api/spawn', { name: 'worker2' });
  await createHostHandler(reg)(req, res);
  assert.deepEqual(reg.calls[0], ['spawn', 'worker2']);
});

test('POST /api/remove calls registry.remove and returns the result', async () => {
  const reg = fakeReg();
  const { req, res } = reqres('POST', '/api/remove', { name: 'worker1' });
  await createHostHandler(reg)(req, res);
  assert.deepEqual(reg.calls[0], ['remove', 'worker1']);
  assert.deepEqual(JSON.parse(res.body), { name: 'worker1', removed: true });
});

test('POST /api/remove refuses the orchestrator with 400', async () => {
  const reg = fakeReg();
  const { req, res } = reqres('POST', '/api/remove', { name: 'orch' });
  await createHostHandler(reg)(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /orchestrator/i);
  assert.ok(!reg.calls.some(([op]) => op === 'remove')); // remove never called
});

test('POST /api/send routes text to the named agent', async () => {
  const reg = fakeReg();
  const { req, res } = reqres('POST', '/api/send', { name: 'worker1', text: 'go' });
  await createHostHandler(reg)(req, res);
  assert.deepEqual(reg.calls[0], ['send', 'worker1', 'go']);
});

test('POST /api/hook (worker idle) writes a pending and self-heals the session id', async () => {
  const reg = fakeReg();
  const pending = [];
  const bus = fakeBusWithPending(pending);
  const { req, res } = reqres('POST', '/api/hook', {
    name: 'worker1', event: 'Notification', notificationType: 'idle_prompt', sessionId: 's9',
  });
  await createHostHandler(reg, { bus })(req, res);
  assert.deepEqual(JSON.parse(res.body).signaled, true);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].worker, 'worker1');
  assert.ok(reg.calls.some(([op, , sid]) => op === 'setSessionId' && sid === 's9'));
});

test('POST /api/send clears the worker outstanding pending', async () => {
  const reg = fakeReg();
  const pending = [{ ref: 'worker1.r1', worker: 'worker1', type: 'freetext', text: 'waiting' }];
  const bus = fakeBusWithPending(pending);
  const { req, res } = reqres('POST', '/api/send', { name: 'worker1', text: 'do it' });
  await createHostHandler(reg, { bus })(req, res);
  assert.deepEqual(reg.calls[0], ['send', 'worker1', 'do it']);
  assert.equal(pending.length, 0); // stale flag cleared
});

test('GET /api/capture?name=worker1 returns captured text', async () => {
  const reg = fakeReg();
  const { req, res } = reqres('GET', '/api/capture?name=worker1');
  await createHostHandler(reg)(req, res);
  assert.equal(res.body, 'cap:worker1');
});

test('GET /api/capture for an unknown agent returns 404 (capture computed before headers -> no double-send)', async () => {
  const reg = { ...fakeReg(), capture() { throw new Error('unknown agent: ghost'); } };
  const { req, res } = reqres('GET', '/api/capture?name=ghost');
  await createHostHandler(reg)(req, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /unknown agent/);
});

test('unknown agent send returns 404 with the error', async () => {
  const reg = { ...fakeReg(), send() { throw new Error('unknown agent: ghost'); } };
  const { req, res } = reqres('POST', '/api/send', { name: 'ghost', text: 'x' });
  await createHostHandler(reg)(req, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /unknown agent: ghost/);
});

test('POST /api/spawn-request/approve spawns the proposed name and clears the pending', async () => {
  const reg = fakeReg();
  const cleared = [];
  const bus = { readPending: () => ({ ref: 'orch.abc', proposedName: 'parser' }), removePending: (r) => cleared.push(r), listPending: () => [] };
  const { req, res } = reqres('POST', '/api/spawn-request/approve', { ref: 'orch.abc' });
  await createHostHandler(reg, { bus })(req, res);
  assert.deepEqual(reg.calls[0], ['spawn', 'parser']);
  assert.deepEqual(cleared, ['orch.abc']);
});

test('GET /api/spawn-requests lists only spawn-request pendings', async () => {
  const reg = fakeReg();
  const bus = { listPending: () => [{ type: 'spawn-request', ref: 'orch.a', proposedName: 'x' }, { type: 'options', ref: 'w.b' }] };
  const { req, res } = reqres('GET', '/api/spawn-requests');
  await createHostHandler(reg, { bus })(req, res);
  const out = JSON.parse(res.body);
  assert.equal(out.length, 1);
  assert.equal(out[0].proposedName, 'x');
});

test('POST /api/persona updates the stored persona without a restart', async () => {
  const calls = [];
  const reg = { ...fakeReg(), setPersona: (n, p) => { calls.push([n, p]); return { changed: true }; } };
  const { req, res } = reqres('POST', '/api/persona', { name: 'orch', persona: 'sharper rules' });
  await createHostHandler(reg)(req, res);
  assert.deepEqual(calls, [['orch', 'sharper rules']]);
  assert.deepEqual(JSON.parse(res.body), { name: 'orch', changed: true });
  assert.ok(!reg.calls.some(([op]) => op === 'restart'));
});
