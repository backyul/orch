import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsage, formatUsage } from '../src/usage.js';

test('formatUsage builds a 5h/7d summary with both reset times', () => {
  const now = new Date('2026-06-22T15:00:00Z').getTime();
  const line = formatUsage({
    five_hour: { utilization: 52, resets_at: '2026-06-22T19:10:00Z' }, // ~4h out -> clock time
    seven_day: { utilization: 31, resets_at: '2026-06-27T23:00:00Z' }, // days out -> date
  }, now);
  assert.match(line, /5h 52% \(resets \d{1,2}:\d{2} (AM|PM)\)/);            // 5h -> "4:10 AM"
  assert.match(line, /7d 31% \(resets [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2} (AM|PM)\)/); // 7d -> "Jun 28 8:00 AM"
});

test('formatUsage returns null for empty data', () => {
  assert.equal(formatUsage(null), null);
  assert.equal(formatUsage({}), null);
});

test('getUsageLine calls the oauth usage endpoint with the bearer token', async () => {
  let seen = null;
  const fetch = async (url, opts) => { seen = { url, auth: opts.headers.Authorization, beta: opts.headers['anthropic-beta'] }; return { ok: true, json: async () => ({ five_hour: { utilization: 10 }, seven_day: { utilization: 5 } }) }; };
  const line = await createUsage({ fetch, getToken: () => 'TOK' }).getUsageLine();
  assert.match(seen.url, /oauth\/usage/);
  assert.equal(seen.auth, 'Bearer TOK');
  assert.equal(seen.beta, 'oauth-2025-04-20');
  assert.match(line, /5h 10%/);
});

test('getUsageLine returns null with no token (no OMC, no creds)', async () => {
  const line = await createUsage({ getToken: () => null }).getUsageLine();
  assert.equal(line, null);
});
