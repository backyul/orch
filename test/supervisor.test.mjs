// test/supervisor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor, AUTO_ALLOWED_TOOLS } from '../src/supervisor.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sup-')); }
const okRun = (reply) => async (args, opts) => ({ stdout: reply, stderr: '' });

test('first ask uses --session-id, later asks --resume the SAME id', async () => {
  const dir = tmp();
  const calls = [];
  const sup = createSupervisor({
    stateDir: dir, cwd: dir, personaText: 'P', approvalsServerPath: 'x.js',
    run: async (args, opts) => { calls.push({ args, opts }); return { stdout: 'ok', stderr: '' }; },
  });
  await sup.ask('hello');
  await sup.ask('again');
  assert.ok(calls[0].args.includes('--session-id'));
  const sid = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.ok(calls[1].args.includes('--resume'));
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], sid);
  assert.equal(calls[0].opts.input, 'hello'); // prompt via stdin, not argv
});

test('launch args carry persona, allowlist, and the approvals permission tool', async () => {
  const dir = tmp();
  let seen;
  const sup = createSupervisor({ stateDir: dir, cwd: dir, personaText: 'P', approvalsServerPath: 'x.js',
    run: async (args) => { seen = args; return { stdout: 'ok', stderr: '' }; } });
  await sup.ask('hi');
  assert.ok(seen.includes('--append-system-prompt-file'));
  assert.ok(seen.includes('--permission-prompt-tool'));
  assert.equal(seen[seen.indexOf('--permission-prompt-tool') + 1], 'mcp__approvals__permission_prompt');
  for (const t of AUTO_ALLOWED_TOOLS) assert.ok(seen.includes(t));
  const mcpFile = seen[seen.indexOf('--mcp-config') + 1];
  const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  assert.equal(mcp.mcpServers.approvals.args[0], 'x.js');
});

test('a failed --resume falls back to a fresh session with a note (never a dead channel)', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'supervisor-session.json'), JSON.stringify({ sessionId: 'stale-id' }));
  let n = 0;
  const sup = createSupervisor({ stateDir: dir, cwd: dir, personaText: 'P', approvalsServerPath: 'x.js',
    run: async (args) => (++n === 1 ? { stdout: '', stderr: 'No conversation found' } : { stdout: 'recovered', stderr: '' }) });
  const r = await sup.ask('hi');
  assert.match(r.reply, /fresh/i);
  assert.match(r.reply, /recovered/);
  assert.notEqual(sup.loadSid(), 'stale-id'); // new sid persisted
});

test('reset archives the session file so the next ask starts fresh', async () => {
  const dir = tmp();
  const sup = createSupervisor({ stateDir: dir, cwd: dir, personaText: 'P', approvalsServerPath: 'x.js', run: okRun('ok') });
  await sup.ask('hi');
  const sid1 = sup.loadSid();
  sup.reset();
  await sup.ask('hi2');
  assert.notEqual(sup.loadSid(), sid1);
});

test('a turn with no output throws (queue retries / reports it)', async () => {
  const dir = tmp();
  const sup = createSupervisor({ stateDir: dir, cwd: dir, personaText: 'P', approvalsServerPath: 'x.js',
    run: async () => ({ stdout: '', stderr: 'boom' }) });
  await assert.rejects(() => sup.ask('hi'), /boom/);
});

test('empty output on a healthy resumed session throws but PRESERVES the session id', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'supervisor-session.json'), JSON.stringify({ sessionId: 'keep-me' }));
  const sup = createSupervisor({ stateDir: dir, cwd: dir, personaText: 'P', approvalsServerPath: 'x.js',
    run: async () => ({ stdout: '', stderr: '' }) });
  await assert.rejects(() => sup.ask('hi'));
  assert.equal(sup.loadSid(), 'keep-me'); // no explicit resume-failure signal -> keep the context
});

test('resume failure with a failing fresh retry archives the stale sid (no permanent wedge)', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'supervisor-session.json'), JSON.stringify({ sessionId: 'stale-id' }));
  const sup = createSupervisor({ stateDir: dir, cwd: dir, personaText: 'P', approvalsServerPath: 'x.js',
    run: async () => ({ stdout: '', stderr: 'No conversation found' }) });
  await assert.rejects(() => sup.ask('hi'));
  assert.notEqual(sup.loadSid(), 'stale-id'); // archived -> null, next ask starts fresh
});

test('repeated resets keep a single .bak, not an ever-growing pile', async () => {
  const dir = tmp();
  const sup = createSupervisor({ stateDir: dir, cwd: dir, personaText: 'P', approvalsServerPath: 'x.js', run: okRun('ok') });
  await sup.ask('hi');
  sup.reset();
  await sup.ask('hi2');
  sup.reset();
  const baks = fs.readdirSync(dir).filter((f) => /supervisor-session\.json\./.test(f));
  assert.equal(baks.length, 1);
});
