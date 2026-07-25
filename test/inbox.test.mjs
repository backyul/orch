import './_isolate-store.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bus from '../src/bus.js';

test('writeInbox + readAndClearInbox round-trips and clears', () => {
  bus.readAndClearInbox(); // start empty
  bus.writeInbox('first message');
  bus.writeInbox('second message');
  const msgs = bus.readAndClearInbox();
  assert.deepEqual(msgs, ['first message', 'second message']);
  assert.deepEqual(bus.readAndClearInbox(), []); // cleared
});

test('orchestratorWorker persists via state', () => {
  bus.writeState({ orchestratorWorker: 'orch' });
  assert.equal(bus.readState().orchestratorWorker, 'orch');
});

test('inboxCount counts without consuming', () => {
  bus.readAndClearInbox();
  assert.equal(bus.inboxCount(), 0);
  bus.writeInbox('a');
  bus.writeInbox('b');
  assert.equal(bus.inboxCount(), 2);
  assert.equal(bus.inboxCount(), 2); // non-destructive
  bus.readAndClearInbox();
  assert.equal(bus.inboxCount(), 0);
});
