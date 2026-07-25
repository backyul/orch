import './_isolate-store.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as bus from '../src/bus.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function runHook(rel, payload, worker) {
  const r = spawnSync('node', [path.join(root, rel)], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ORCH_WORKER: worker, TMUX_PANE: '%7' },
  });
  assert.equal(r.status, 0, r.stderr);
}

test('notify-hook writes a freetext pending for an actionable message', () => {
  const worker = 'hooktest_n_' + process.pid;
  runHook('hooks/notify-hook.mjs', { message: 'Which database should I migrate?' }, worker);
  const p = bus.listPending().find(x => x.worker === worker);
  assert.ok(p, 'pending created');
  assert.equal(p.type, 'freetext');
  assert.equal(p.paneId, '%7');
  assert.match(p.text, /Which database/);
  bus.removePending(p.ref);
});

test('notify-hook SUPPRESSES idle notifications (no pending)', () => {
  for (const msg of ['Claude is waiting for your input', '']) {
    const worker = 'hooktest_sup_' + process.pid + '_' + Math.floor(Math.random() * 1e6);
    runHook('hooks/notify-hook.mjs', { message: msg }, worker);
    const p = bus.listPending().find(x => x.worker === worker);
    assert.equal(p, undefined, `should suppress: "${msg}"`);
  }
});

test('notify-hook flags a permission prompt as type "permission" (for enrichment)', () => {
  const worker = 'hooktest_perm_' + process.pid;
  runHook('hooks/notify-hook.mjs', { message: 'Claude needs your permission to use Bash' }, worker);
  const p = bus.listPending().find(x => x.worker === worker);
  assert.ok(p, 'permission pending created');
  assert.equal(p.type, 'permission');
  bus.removePending(p.ref);
});

test('answered-hook clears any pending for the worker', () => {
  const worker = 'hooktest_ans_' + process.pid;
  const ref = bus.genRef(worker);
  bus.writePending({ ref, worker, paneId: '%7', type: 'options', text: 'q', options: ['a', 'b'], createdAt: 1 });
  runHook('hooks/answered-hook.mjs', {}, worker);
  assert.equal(bus.readPending(ref), null, 'pending cleared after answer');
});

test('ask-hook writes an options pending from AskUserQuestion', () => {
  const worker = 'hooktest_a_' + process.pid;
  runHook('hooks/ask-hook.mjs',
    { tool_input: { questions: [{ question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }, worker);
  const p = bus.listPending().find(x => x.worker === worker);
  assert.ok(p);
  assert.equal(p.type, 'options');
  assert.deepEqual(p.options, ['Yes', 'No']);
  assert.match(p.text, /Deploy now/);
  bus.removePending(p.ref);
});
