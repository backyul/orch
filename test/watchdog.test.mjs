// test/watchdog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatchdog } from '../src/watchdog.js';
import { pollerLockFile } from '../src/poller-lock.js';

test('pollerLockFile is exported and deterministic per token', () => {
  assert.equal(pollerLockFile('tok', { lockDir: '/x' }), pollerLockFile('tok', { lockDir: '/x' }));
});

test('a check must fail twice (strikes) before alerting, and alerts once per red episode', async () => {
  let ok = false;
  let t = 0;
  const sweep = createWatchdog({
    checks: [{ name: 'hostApi', check: async () => ({ ok, detail: 'conn refused' }) }],
    now: () => t, intervalMs: 100, strikes: 2,
  });
  assert.deepEqual(await sweep(), []);        // strike 1 — no alert yet
  t += 100;
  const alerts = await sweep();               // strike 2 — alert
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /hostApi/);
  t += 100;
  assert.deepEqual(await sweep(), []);        // still red — no repeat alert
  ok = true; t += 100;
  await sweep();                              // green — episode resets
  ok = false; t += 100;
  await sweep(); t += 100;
  assert.equal((await sweep()).length, 1);    // new red episode -> new alert
});

test('sweeps are throttled to intervalMs', async () => {
  let calls = 0;
  const sweep = createWatchdog({ checks: [{ name: 'c', check: async () => { calls++; return { ok: true }; } }], now: () => 0, intervalMs: 1000 });
  await sweep(); await sweep();
  assert.equal(calls, 1);
});
