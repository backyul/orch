import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEscalations } from '../src/escalation.js';

const p = (over) => ({ ref: 'w.a', createdAt: 0, ...over });

test('away=true escalates immediately, reason away', () => {
  const out = computeEscalations({ pending: [p()], state: { away: true }, now: 10 });
  assert.deepEqual(out, [{ ref: 'w.a', reason: 'away' }]);
});

test('not away, under timeout -> no escalation', () => {
  const out = computeEscalations({ pending: [p()], state: { away: false }, now: 1000, timeoutMs: 90000 });
  assert.deepEqual(out, []);
});

test('not away, over timeout -> reason timeout', () => {
  const out = computeEscalations({ pending: [p()], state: { away: false }, now: 90000, timeoutMs: 90000 });
  assert.deepEqual(out, [{ ref: 'w.a', reason: 'timeout' }]);
});

test('already escalated is skipped', () => {
  const out = computeEscalations({ pending: [p({ escalatedAt: 5 })], state: { away: true }, now: 10 });
  assert.deepEqual(out, []);
});

test('permission-type pending is not escalated (waits for enrichment)', () => {
  const out = computeEscalations({ pending: [p({ type: 'permission' })], state: { away: true }, now: 10 });
  assert.deepEqual(out, []);
});
