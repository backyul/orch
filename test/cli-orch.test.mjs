import './_isolate-store.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as bus from '../src/bus.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function cli(...args) { return spawnSync('node', [path.join(root, 'src', 'cli.js'), ...args], { encoding: 'utf8' }); }

test('set-orchestrator stores the name', () => {
  const r = cli('set-orchestrator', 'orch');
  assert.equal(r.status, 0);
  assert.equal(bus.readState().orchestratorWorker, 'orch');
});

test('say is shown at the terminal (not sent to Telegram) when the operator is present', () => {
  bus.writeState({ away: false, lastChannel: 'terminal', lastChannelAt: Date.now() }); // present
  for (const e of bus.listOutbox()) bus.removeOutbox(e.id);
  const r = cli('say', 'a present-mode message');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /shown here/);
  assert.match(r.stdout, /a present-mode message/); // shown locally instead of a phone ping
  // but never silently droppable anymore: it sits in the outbox for the daemon's 5-min sweep
  assert.equal(bus.listOutbox().length, 1);
});

test('inbox prints and clears queued messages', () => {
  bus.readAndClearInbox();
  bus.writeInbox('hello from user');
  const r = cli('inbox');
  assert.match(r.stdout, /hello from user/);
  assert.equal(bus.readAndClearInbox().length, 0);
});

test('answer resolves an options pending by number (no real pane => reports failure, still clears)', () => {
  const worker = 'clitest_' + process.pid;
  const ref = bus.genRef(worker);
  bus.writePending({ ref, worker, paneId: '', type: 'options', text: 'q', options: ['Yes', 'No'], createdAt: 1 });
  const r = cli('answer', ref, '2'); // pick option 2 = No
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No|could not|gone|FAILED/i);
  assert.equal(bus.readPending(ref), null); // cleared
});
