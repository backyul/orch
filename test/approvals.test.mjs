// test/approvals.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRequest, listRequests, readRequest, updateRequest, answerRequest, readAnswer, purgeOld } from '../src/approvals.js';

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'apv-')); }

test('request lifecycle: write -> list -> update -> answer', () => {
  const d = dir();
  const r = writeRequest(d, { toolName: 'Bash', input: { command: 'git push' } , now: () => 1000 });
  assert.ok(r.id);
  let [seen] = listRequests(d);
  assert.equal(seen.toolName, 'Bash');
  assert.equal(seen.answered, false);
  updateRequest(d, r.id, { messageId: 77 });
  assert.equal(readRequest(d, r.id).messageId, 77);
  answerRequest(d, r.id, true);
  [seen] = listRequests(d);
  assert.equal(seen.answered, true);
  assert.equal(readAnswer(d, r.id).allow, true);
});

test('ids are 12 hex chars', () => {
  const d = dir();
  const r = writeRequest(d, { toolName: 'T', input: {} });
  assert.ok(/^[0-9a-f]{12}$/.test(r.id));
});

test('purgeOld removes answered requests past the ttl, keeps live ones', () => {
  const d = dir();
  const a = writeRequest(d, { toolName: 'T', input: {}, now: () => 0 });
  answerRequest(d, a.id, false);
  const b = writeRequest(d, { toolName: 'T2', input: {}, now: () => 0 });
  purgeOld(d, { now: () => 100_000_000, ttlMs: 1000 });
  assert.equal(readRequest(d, a.id), null);       // answered + old -> gone
  assert.ok(readRequest(d, b.id));                // unanswered -> kept (still awaiting operator)
});

test('writeRequest carries an optional worker tag through to listRequests', () => {
  const d = dir();
  writeRequest(d, { toolName: 'Bash', input: { command: 'rm x' }, worker: 'alpha' });
  writeRequest(d, { toolName: 'Read', input: {} });
  const [a, b] = listRequests(d);
  assert.equal(a.worker, 'alpha');
  assert.equal(b.worker, undefined);
});
