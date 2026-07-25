import './_isolate-store.js';
// Loud isolation guard: the bare `cli(...)` helper below spawns cli.js WITHOUT an env override,
// so the subprocess inherits ORCH_STATE_DIR. Run via `npm test` (whose --import ./test/_setup.mjs
// isolates it); a direct `node --test test/cli.test.mjs` would silently write to the LIVE
// ~/.claude/orchestrator store — fail fast instead (this nearly caused a real incident).
if (!process.env.ORCH_STATE_DIR || /[\\/]\.claude[\\/]orchestrator([\\/]|$)/.test(process.env.ORCH_STATE_DIR)) {
  throw new Error('ORCH_STATE_DIR is not isolated — run via `npm test`, not `node --test` directly');
}
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import * as bus from '../src/bus.js';
import { readLast, TRANSCRIPT_FILE } from '../src/transcript.js';
import fs from 'node:fs';
import { writeRequest, readAnswer, listRequests } from '../src/approvals.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function cli(...args) {
  return spawnSync('node', [path.join(root, 'src', 'cli.js'), ...args], { encoding: 'utf8' });
}

// Helpers for team-verb tests — spawn cli.js with an explicit isolated state dir.
function runCliRaw(args, stateDir) {
  return spawnSync('node', [path.join(root, 'src', 'cli.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ORCH_STATE_DIR: stateDir },
  });
}
function runCli(args, stateDir) {
  const r = runCliRaw(args, stateDir);
  if (r.status !== 0) throw new Error(`cli exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
function seedWorker(dir, name) {
  const teamDir = path.join(dir, 'team');
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, `${name}.json`), JSON.stringify({
    name, status: 'active', queuedMessages: [], turnCount: 0, sinceDigest: 0,
    task: 't', branch: `team/${name}`, worktree: dir, createdAt: 1,
  }));
}

test('away/back toggle persisted state', () => {
  cli('away');
  assert.equal(bus.readState().away, true);
  cli('back');
  assert.equal(bus.readState().away, false);
});

test('back asserts the terminal as last channel (manual override re-routes say to the pane)', () => {
  bus.writeState({ away: true, lastChannel: 'telegram', lastChannelAt: 1 });
  cli('back');
  const st = bus.readState();
  assert.equal(st.away, false);
  assert.equal(st.lastChannel, 'terminal');
});

test('say with operator at the terminal prints the message, outboxes it, and logs the transcript', () => {
  fs.rmSync(TRANSCRIPT_FILE, { force: true });
  for (const e of bus.listOutbox()) bus.removeOutbox(e.id);
  bus.writeState({ away: false, lastChannel: 'terminal', lastChannelAt: Date.now() });
  const r = cli('say', 'hello from orch');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hello from orch/);
  const ob = bus.listOutbox();
  assert.equal(ob.length, 1);
  assert.equal(ob[0].text, 'hello from orch');
  const t = readLast(5);
  assert.equal(t.at(-1).text, 'hello from orch');
  assert.equal(t.at(-1).channel, 'terminal');
});

test('transcript command prints the unified history', () => {
  fs.rmSync(TRANSCRIPT_FILE, { force: true });
  bus.writeState({ away: false, lastChannel: 'terminal', lastChannelAt: Date.now() });
  cli('say', 'one for the record');
  const r = cli('transcript', '10');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /one for the record/);
  assert.match(r.stdout, /orch/);
});

test('register-worker stores name->pane in state', () => {
  const r = cli('register-worker', 'w9', '%9');
  assert.equal(r.status, 0);
  assert.equal(bus.readState().workers.w9, '%9');
});

test('status prints JSON with state + pending + outbox', () => {
  const r = cli('status');
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok('state' in parsed && 'pending' in parsed && 'outbox' in parsed);
});

test('dismiss clears a pending without sending anything to the worker', () => {
  bus.ensureDirs();
  bus.writePending({ ref: 'wz.dd', worker: 'wz', type: 'freetext', text: 'idle, no task', createdAt: 1 });
  const r = cli('dismiss', 'wz.dd');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dismissed wz\.dd/);
  assert.equal(bus.readPending('wz.dd'), null);
});

// ── Team verb tests ────────────────────────────────────────────────────────

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-team-')); }

test('team-status on an empty team prints "(no workers)"', () => {
  const dir = tmp();
  const out = runCli(['team-status'], dir);
  assert.match(out, /no workers/i);
});

test('team-send to a missing worker fails loudly', () => {
  const dir = tmp();
  const { status, stderr } = runCliRaw(['team-send', 'ghost', 'hi'], dir);
  assert.notEqual(status, 0);
  assert.match(stderr, /no such worker/);
});

test('team-approve answers the request; late approve queues a retry note to the worker', () => {
  const dir = tmp();
  // late request (older than APPROVAL_WAIT_MS) from worker alpha, already registered
  seedWorker(dir, 'alpha');
  const r = writeRequest(dir, { toolName: 'Bash', input: {}, worker: 'alpha',
    now: () => Date.now() - 10 * 60_000 });
  runCli(['team-approve', r.id, 'allow'], dir);
  assert.equal(readAnswer(dir, r.id).allow, true);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'team', 'alpha.json'), 'utf8'));
  assert.match(w.queuedMessages.join(' '), /APPROVED.*retry/i);
});

test('team-escalate flags the request for the Telegram path', () => {
  const dir = tmp();
  const r = writeRequest(dir, { toolName: 'Bash', input: {}, worker: 'alpha' });
  runCli(['team-escalate', r.id], dir);
  assert.equal(listRequests(dir)[0].escalated, true);
});
