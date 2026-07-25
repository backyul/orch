import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createOrchestrator } from '../src/orchestrator.js';

test('ask invokes claude -p with prompt, returns result text, persists session id', () => {
  const sessionFile = path.join(os.tmpdir(), `orchsess-${process.pid}.json`);
  try { fs.unlinkSync(sessionFile); } catch {}
  const calls = [];
  const exec = (cmd, args, opts) => { calls.push([cmd, args, opts]); return JSON.stringify({ result: 'W1 building tests', session_id: 'sid-1' }); };
  const orch = createOrchestrator({ exec, sessionFile });

  const out1 = orch.ask('what is happening?', 'CTX');
  assert.equal(out1, 'W1 building tests');
  assert.equal(calls[0][0], 'claude');
  assert.ok(calls[0][1].includes('-p'));
  assert.ok(calls[0][1].some(a => a.includes('CTX')));
  assert.ok(!calls[0][1].includes('--resume')); // first call: no session yet
  assert.equal(calls[0][2].timeout, 60000); // FIX 2: brain-call timeout

  const out2 = orch.ask('and now?', 'CTX2');
  assert.equal(out2, 'W1 building tests');
  assert.ok(calls[1][1].includes('--resume'));
  assert.ok(calls[1][1].includes('sid-1'));
  fs.unlinkSync(sessionFile);
});
