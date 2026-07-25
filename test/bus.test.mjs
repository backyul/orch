import './_isolate-store.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PENDING_DIR } from '../src/config.js';
import * as bus from '../src/bus.js';

function uniq() { return 'test_' + process.pid + '_' + Math.floor(Math.random() * 1e6); }

afterEach(() => {
  for (const p of bus.listPending()) if (p.worker?.startsWith('test_')) bus.removePending(p.ref);
});

test('genRef is filename-safe and namespaced by worker', () => {
  const ref = bus.genRef('W 2/x', () => 0); // rand -> 'aaa'
  assert.equal(ref, 'W2x.aaa');
});

test('writePending + readPending + listPending round-trip', () => {
  const worker = uniq();
  const ref = bus.genRef(worker);
  bus.writePending({ ref, worker, paneId: '%1', type: 'freetext', text: 'hi', options: [], createdAt: 1 });
  const got = bus.readPending(ref);
  assert.equal(got.text, 'hi');
  assert.ok(bus.listPending().some(p => p.ref === ref));
  assert.ok(fs.existsSync(`${PENDING_DIR}/${ref}.json`));
});

test('updatePending merges', () => {
  const worker = uniq();
  const ref = bus.genRef(worker);
  bus.writePending({ ref, worker, paneId: '%1', type: 'freetext', text: 'hi', options: [], createdAt: 1 });
  bus.updatePending(ref, { escalatedAt: 5, messageId: 42 });
  const got = bus.readPending(ref);
  assert.equal(got.escalatedAt, 5);
  assert.equal(got.messageId, 42);
  assert.equal(got.text, 'hi');
});

test('removePending deletes', () => {
  const worker = uniq();
  const ref = bus.genRef(worker);
  bus.writePending({ ref, worker, paneId: '%1', type: 'freetext', text: 'x', options: [], createdAt: 1 });
  bus.removePending(ref);
  assert.equal(bus.readPending(ref), null);
});

test('outbox: write + list + remove round-trip, ordered by write time', () => {
  for (const e of bus.listOutbox()) bus.removeOutbox(e.id);
  const a = bus.writeOutbox({ text: 'first', shownAt: 100 });
  const b = bus.writeOutbox({ text: 'second', shownAt: 200 });
  const got = bus.listOutbox();
  assert.deepEqual(got.map((e) => e.text), ['first', 'second']);
  assert.equal(got[0].shownAt, 100);
  assert.ok(a.id && b.id && a.id !== b.id);
  bus.removeOutbox(a.id);
  assert.deepEqual(bus.listOutbox().map((e) => e.text), ['second']);
  bus.removeOutbox(b.id);
  assert.deepEqual(bus.listOutbox(), []);
});

test('state read default + write merge', () => {
  const s = bus.writeState({ away: true, awaySetAt: 123 });
  assert.equal(s.away, true);
  assert.equal(bus.readState().away, true);
  bus.writeState({ away: false });
  assert.equal(bus.readState().away, false);
});
