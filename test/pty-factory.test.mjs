import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeCommand, cleanAgentEnv } from '../src/pty-factory.js';

test('cleanAgentEnv strips the launcher Claude-session identity, sets ORCH_WORKER, keeps OMC on', () => {
  const out = cleanAgentEnv({ FOO: '1', CLAUDE_CODE_SESSION_ID: 'cc', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_JOB_DIR: 'x' }, 'orch');
  assert.equal(out.FOO, '1');
  assert.equal(out.ORCH_WORKER, 'orch');
  assert.equal(out.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(out.CLAUDE_CODE_CHILD_SESSION, undefined);
  assert.equal(out.CLAUDE_JOB_DIR, undefined);
  assert.equal(out.DISABLE_OMC, '1'); // OMC context hooks off (memory/recap); HUD is gated separately
});

test('cleanAgentEnv keeps OMC when AGENT_GRID_KEEP_OMC is set', () => {
  const out = cleanAgentEnv({ AGENT_GRID_KEEP_OMC: '1' }, 'w1');
  assert.equal(out.DISABLE_OMC, undefined);
});

test('cleanAgentEnv sets the Nova-parity launch hardening vars', () => {
  const out = cleanAgentEnv({}, 'w1');
  assert.equal(out.DISABLE_AUTOUPDATER, '1');
  assert.equal(out.CLAUDE_CODE_DISABLE_AGENT_VIEW, '1');
});

test('every agent launches with --no-chrome (blocks the computer-use lock path)', () => {
  const { args } = buildClaudeCommand({ resume: false, sessionId: 'u', name: 'orch' });
  assert.ok(args.includes('--no-chrome'));
});

test('fresh launch with a session id uses --session-id (not --resume)', () => {
  const { args } = buildClaudeCommand({ resume: false, sessionId: 'uuid-1' });
  assert.ok(!args.includes('--resume'));
  const i = args.indexOf('--session-id');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'uuid-1');
});

test('resume launch includes --resume <sessionId> and not --session-id', () => {
  const { args } = buildClaudeCommand({ resume: true, sessionId: 'sid-9' });
  const i = args.indexOf('--resume');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'sid-9');
  assert.ok(!args.includes('--session-id'));
});

test('a display name adds -n <name>', () => {
  const { args } = buildClaudeCommand({ resume: false, sessionId: 'u', name: 'backend' });
  const i = args.indexOf('-n');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'backend');
});

test('a persona file adds --append-system-prompt-file <path>', () => {
  const { args } = buildClaudeCommand({ resume: false, sessionId: 'u', personaFile: '/tmp/p.txt' });
  const i = args.indexOf('--append-system-prompt-file');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], '/tmp/p.txt');
});

test('no persona file means no --append-system-prompt-file', () => {
  const { args } = buildClaudeCommand({ resume: false, sessionId: 'u' });
  assert.ok(!args.includes('--append-system-prompt-file'));
});

test('a settings file adds --settings <path> (blanks the OMC HUD)', () => {
  const { args } = buildClaudeCommand({ resume: false, sessionId: 'u', settingsFile: '/tmp/quiet.json' });
  const i = args.indexOf('--settings');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], '/tmp/quiet.json');
});

test('without a settings file there is no --settings override', () => {
  const { args } = buildClaudeCommand({ resume: false, sessionId: 'u' });
  assert.ok(!args.includes('--settings'));
});

test('every agent launches with --permission-mode bypassPermissions by default', () => {
  const { args } = buildClaudeCommand({ resume: false, sessionId: 'u', name: 'orch' });
  const i = args.indexOf('--permission-mode');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'bypassPermissions');
});

test('permissionMode:null falls back to Claude interactive mode (no flag)', () => {
  const { args } = buildClaudeCommand({ resume: false, sessionId: 'u', permissionMode: null });
  assert.ok(!args.includes('--permission-mode'));
});
