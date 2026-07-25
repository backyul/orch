import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostClient } from '../src/host-client.js';

function fakeFetch(log) {
  return async (url, opts) => { log.push([url, opts?.method || 'GET', opts?.body]); return { ok: true, json: async () => ({ ok: true }) }; };
}

test('sendKeys POSTs the text then a SEPARATE CR; a clean capture means no retries', async () => {
  const log = [];
  const hc = createHostClient({ base: 'http://h', fetch: fakeFetch(log), captureSync: () => '> \n(empty prompt)' });
  hc.sendKeys('worker1', 'do X please worker one');
  await hc.flush();
  assert.equal(log.length, 2); // text + one Enter — verification saw no strand
  assert.match(log[0][0], /\/api\/send$/);
  assert.equal(log[0][1], 'POST');
  assert.deepEqual(JSON.parse(log[0][2]), { name: 'worker1', text: 'do X please worker one' });
  assert.deepEqual(JSON.parse(log[1][2]), { name: 'worker1', text: '\r' });
});

test('sendKeys retries Enter when the text is still stranded in the input box', async () => {
  const log = [];
  let strandedOnce = true;
  const hc = createHostClient({
    base: 'http://h', fetch: fakeFetch(log),
    // first verification sees the text parked at the bottom; after the retry it's gone
    captureSync: () => { const s = strandedOnce ? '> rerun the after aneurysm eval to check flakiness' : '> '; strandedOnce = false; return s; },
  });
  hc.sendKeys('Raggi', 'rerun the after aneurysm eval to check flakiness');
  await hc.flush();
  assert.equal(log.length, 3); // text + Enter + ONE retry Enter (second check was clean)
  assert.deepEqual(JSON.parse(log[2][2]), { name: 'Raggi', text: '\r' });
});

test('sendKeys flattens newlines so multi-line text cannot strand in the input box', async () => {
  const log = [];
  const hc = createHostClient({ base: 'http://h', fetch: fakeFetch(log), captureSync: () => '' });
  hc.sendKeys('worker1', 'line one\nline two\r\n  line three');
  await hc.flush();
  assert.deepEqual(JSON.parse(log[0][2]), { name: 'worker1', text: 'line one line two line three' });
});

test('sendKeys with enter:false omits the trailing CR', async () => {
  const log = [];
  const hc = createHostClient({ base: 'http://h', fetch: fakeFetch(log) });
  hc.sendKeys('worker1', '2', { enter: false });
  await hc.flush();
  assert.deepEqual(JSON.parse(log[0][2]), { name: 'worker1', text: '2' });
});

test('capturePane returns the synchronous capture text for the named agent', () => {
  const seen = [];
  const hc = createHostClient({ base: 'http://h', captureSync: (n) => { seen.push(n); return `cap:${n}`; } });
  assert.equal(hc.capturePane('worker1'), 'cap:worker1');
  assert.deepEqual(seen, ['worker1']);
});

test('spawn POSTs the name to /api/spawn', async () => {
  const log = [];
  const hc = createHostClient({ base: 'http://h', fetch: fakeFetch(log) });
  await hc.spawn('parser');
  assert.match(log[0][0], /\/api\/spawn$/);
  assert.deepEqual(JSON.parse(log[0][2]), { name: 'parser' });
});
