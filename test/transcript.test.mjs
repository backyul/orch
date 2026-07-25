import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { append, readLast, TRANSCRIPT_FILE } from '../src/transcript.js';

test('append then readLast returns entries in order', () => {
  fs.rmSync(TRANSCRIPT_FILE, { force: true });
  append({ ts: 1000, from: 'operator', channel: 'telegram', text: 'hello orch' });
  append({ ts: 2000, from: 'orch', channel: 'telegram', text: 'hello operator' });
  const got = readLast(10);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { ts: 1000, from: 'operator', channel: 'telegram', text: 'hello orch' });
  assert.deepEqual(got[1], { ts: 2000, from: 'orch', channel: 'telegram', text: 'hello operator' });
});

test('readLast(n) returns only the last n entries', () => {
  fs.rmSync(TRANSCRIPT_FILE, { force: true });
  for (let i = 0; i < 5; i++) append({ ts: i, from: 'orch', channel: 'terminal', text: `m${i}` });
  const got = readLast(2);
  assert.deepEqual(got.map((e) => e.text), ['m3', 'm4']);
});

test('readLast tolerates a corrupt line and a missing file', () => {
  fs.rmSync(TRANSCRIPT_FILE, { force: true });
  assert.deepEqual(readLast(5), []); // no file yet
  append({ ts: 1, from: 'orch', channel: 'terminal', text: 'good' });
  fs.appendFileSync(TRANSCRIPT_FILE, 'NOT JSON{{{\n');
  append({ ts: 2, from: 'operator', channel: 'telegram', text: 'also good' });
  const got = readLast(10);
  assert.deepEqual(got.map((e) => e.text), ['good', 'also good']);
});

test('transcript file lives under the (isolated) state dir', () => {
  // _setup.mjs points ORCH_STATE_DIR at a throwaway tmp dir; the transcript must follow it,
  // never the real ~/.claude/orchestrator.
  assert.equal(path.dirname(TRANSCRIPT_FILE), path.resolve(process.env.ORCH_STATE_DIR));
});
