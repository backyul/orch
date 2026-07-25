// test/approvals-mcp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleMessage, decidePermission } from '../src/approvals-mcp.js';
import { listRequests, answerRequest } from '../src/approvals.js';

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-')); }

test('initialize and tools/list speak MCP', async () => {
  const d = dir();
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { stateDir: d });
  assert.ok(init.result.serverInfo.name);
  const tools = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { stateDir: d });
  assert.equal(tools.result.tools[0].name, 'permission_prompt');
});

test('an approved request returns behavior allow with the original input', async () => {
  const d = dir();
  const p = decidePermission({ tool_name: 'Bash', input: { command: 'git push' } }, { stateDir: d, waitMs: 3000, pollMs: 20 });
  // simulate the operator tapping Allow shortly after the request lands
  await new Promise((r) => setTimeout(r, 60));
  const [req] = listRequests(d);
  answerRequest(d, req.id, true);
  const decision = await p;
  assert.equal(decision.behavior, 'allow');
  assert.deepEqual(decision.updatedInput, { command: 'git push' });
});

test('no answer within waitMs returns deny with PENDING guidance', async () => {
  const d = dir();
  const decision = await decidePermission({ tool_name: 'Bash', input: { command: 'rm -rf x' } }, { stateDir: d, waitMs: 80, pollMs: 20 });
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.message, /PENDING/i);
  assert.equal(listRequests(d).length, 1); // request survives for the late-approve path
});

test('decidePermission stamps the request with the worker option', async () => {
  const d = dir();
  const p = decidePermission({ tool_name: 'Bash', input: {} }, { stateDir: d, waitMs: 50, pollMs: 5, worker: 'alpha' });
  await p;
  assert.equal(listRequests(d)[0].worker, 'alpha');
});
