import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ORCH_DIR, PENDING_DIR, IDLE_TIMEOUT_MS, loadEnv, APPROVAL_WAIT_MS, APPROVAL_REPING_MS, TURN_TIMEOUT_MS, WATCHDOG_INTERVAL_MS, WORKER_TURN_CAP, DIGEST_EVERY_TURNS, MAX_WORKER_TURNS } from '../src/config.js';

test('paths default to ~/.claude/orchestrator when ORCH_STATE_DIR is unset', () => {
  // The suite runs with ORCH_STATE_DIR pinned to a tmp dir (test/_setup.mjs), so assert the DEFAULT
  // in a child process with it unset — env-independent, and never touches the real store.
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const env = { ...process.env };
  delete env.ORCH_STATE_DIR;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify(configUrl)}).then(m => console.log(m.ORCH_DIR + '|' + m.PENDING_DIR));`],
    { env, encoding: 'utf8' });
  const [dir, pending] = out.trim().split('|');
  assert.equal(dir, path.join(os.homedir(), '.claude', 'orchestrator'));
  assert.ok(pending.endsWith(path.join('orchestrator', 'pending')));
});

test('idle timeout is 90s', () => {
  assert.equal(IDLE_TIMEOUT_MS, 90_000);
});

test('ORCH_STATE_DIR overrides the state dir (isolated instance, e.g. the cockpit GUI)', () => {
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const altRoot = path.join(os.tmpdir(), 'orch-gui-test');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify(configUrl)}).then(m => console.log(m.ORCH_DIR + '|' + m.PENDING_DIR));`],
    { env: { ...process.env, ORCH_STATE_DIR: altRoot }, encoding: 'utf8' });
  const [dir, pending] = out.trim().split('|');
  assert.equal(dir, path.resolve(altRoot));
  assert.ok(pending.endsWith(path.join('orch-gui-test', 'pending')));
});

test('loadEnv parses KEY=VALUE and strips quotes', () => {
  const tmp = path.join(os.tmpdir(), `env-${process.pid}.txt`);
  fs.writeFileSync(tmp, 'TELEGRAM_BOT_TOKEN="abc:123"\nTELEGRAM_ALLOWED_CHAT_ID=999\n');
  const env = loadEnv(tmp);
  assert.equal(env.botToken, 'abc:123');
  assert.equal(env.allowedChatId, '999');
  fs.unlinkSync(tmp);
});

test('loadEnv reads ORCH_MODE from the env file', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), '.env');
  fs.writeFileSync(f, 'TELEGRAM_BOT_TOKEN=t\nTELEGRAM_ALLOWED_CHAT_ID=1\nORCH_MODE=supervisor\n');
  const env = loadEnv(f);
  assert.equal(env.orchMode, 'supervisor');
});

test('supervisor timing constants exist and are sane', () => {
  assert.equal(APPROVAL_WAIT_MS, 120_000);
  assert.ok(APPROVAL_REPING_MS > APPROVAL_WAIT_MS);
  assert.equal(TURN_TIMEOUT_MS, 900_000);
  assert.ok(WATCHDOG_INTERVAL_MS >= 10_000);
});

test('team constants exported with spec values', () => {
  assert.equal(WORKER_TURN_CAP, 50);
  assert.equal(DIGEST_EVERY_TURNS, 5);
  assert.equal(MAX_WORKER_TURNS, 3);
});
