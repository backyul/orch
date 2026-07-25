import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSpawnRequest } from '../src/spawn-request.js';

test('makeSpawnRequest writes a spawn-request pending with name + why', () => {
  const written = [];
  const bus = { writePending: (rec) => { written.push(rec); return rec; }, genRef: () => 'orch.abc' };
  const rec = makeSpawnRequest(bus, { name: 'parser', why: 'big refactor' });
  assert.equal(written.length, 1);
  assert.equal(rec.type, 'spawn-request');
  assert.equal(rec.proposedName, 'parser');
  assert.equal(rec.why, 'big refactor');
  assert.equal(rec.worker, 'orch');
  assert.equal(rec.ref, 'orch.abc');
});
