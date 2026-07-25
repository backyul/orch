import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeAnswer } from '../src/route.js';

function fakeBus(pending, state) {
  const replies = [];
  return { _replies: replies,
    readState: () => state, readPending: (r) => pending[r] || null,
    writeReply: (rec) => replies.push(rec),
    removePending: (r) => { delete pending[r]; } };
}
function fakeTmux(keys) { return { sendKeys: (pane, text, opts) => keys.push({ pane, text, enter: opts?.enter !== false }) }; }

test('options answer sends the option number to the registered pane, no Enter', () => {
  const keys = [];
  const bus = fakeBus({ 'w1.a': { ref: 'w1.a', worker: 'w1', paneId: '%1', type: 'options', options: ['Yes', 'No'] } },
    { workers: { w1: 'sess:%1' } });
  const r = routeAnswer(bus.readPending('w1.a'), 'No', 'orchestrator', { bus, tmux: fakeTmux(keys) });
  assert.equal(r.delivered, true);
  assert.deepEqual(keys[0], { pane: 'sess:%1', text: '2', enter: false });
  assert.equal(bus._replies[0].answer, 'No');
  assert.equal(bus.readPending('w1.a'), null);
});

test('free-text answer types text + Enter; missing pane => not delivered', () => {
  const keys = [];
  const bus = fakeBus({ 'w2.b': { ref: 'w2.b', worker: 'w2', paneId: '', type: 'freetext' } }, { workers: {} });
  const r = routeAnswer(bus.readPending('w2.b'), 'use config.js', 'orchestrator', { bus, tmux: fakeTmux(keys) });
  assert.equal(r.delivered, false);
  assert.equal(keys.length, 0);
});
