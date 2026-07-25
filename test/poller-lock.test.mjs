// The getUpdates-409 fix: (a) a per-token singleton lock so a second daemon on the SAME bot token
// fails fast and loudly instead of silently fighting the poller (the 2.2MB err-log flood), and
// (b) a longer, quieter poll backoff when a 409 does occur (foreign process outside our lock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquirePollerLock, is409Conflict } from '../src/poller-lock.js';
import { runDaemon } from '../src/daemon.js';
import { POLL_409_BACKOFF_MS, POLL_ERROR_BACKOFF_MS } from '../src/config.js';

function tmpLockDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lock-')); }
function deadPid() {
  // A REAL dead pid (spawn a no-op child and let it exit) — no guessing at unallocated pids.
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid;
}

test('acquire succeeds and a SECOND PROCESS acquiring the same token is refused with the holder pid', () => {
  const lockDir = tmpLockDir();
  const first = acquirePollerLock('tok-A', { lockDir });
  assert.equal(first.ok, true);
  // the contender is a DIFFERENT (alive) process — use our parent pid to model it
  const second = acquirePollerLock('tok-A', { lockDir, pid: process.ppid });
  assert.equal(second.ok, false);
  assert.equal(second.holderPid, process.pid);
  // same-pid re-acquire is re-entrant by design (a daemon restarting in place)
  assert.equal(acquirePollerLock('tok-A', { lockDir }).ok, true);
});

test('different tokens do not contend', () => {
  const lockDir = tmpLockDir();
  assert.equal(acquirePollerLock('tok-A', { lockDir }).ok, true);
  assert.equal(acquirePollerLock('tok-B', { lockDir }).ok, true);
});

test('a stale lock from a dead process is taken over', () => {
  const lockDir = tmpLockDir();
  const stale = acquirePollerLock('tok-A', { lockDir, pid: deadPid() });
  assert.equal(stale.ok, true);
  const takeover = acquirePollerLock('tok-A', { lockDir });
  assert.equal(takeover.ok, true);
});

test('release frees the lock for the next acquire', () => {
  const lockDir = tmpLockDir();
  const first = acquirePollerLock('tok-A', { lockDir });
  first.release();
  assert.equal(acquirePollerLock('tok-A', { lockDir }).ok, true);
});

test('lock files never contain the token itself (hash only)', () => {
  const lockDir = tmpLockDir();
  acquirePollerLock('SECRET-TOKEN-VALUE', { lockDir });
  for (const f of fs.readdirSync(lockDir)) {
    assert.ok(!f.includes('SECRET-TOKEN-VALUE'));
    assert.ok(!fs.readFileSync(path.join(lockDir, f), 'utf8').includes('SECRET-TOKEN-VALUE'));
  }
});

test('is409Conflict recognizes the Telegram conflict error and nothing else', () => {
  assert.equal(is409Conflict(new Error('telegram getUpdates failed: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running')), true);
  assert.equal(is409Conflict(new Error('fetch failed')), false);
});

test('runDaemon backs off long on 409 (and logs once), short on other poll errors', async () => {
  const sleeps = []; const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let polls = 0;
  const tg = { getUpdates: async () => { polls++; throw new Error('telegram getUpdates failed: Conflict: terminated by other getUpdates request'); } };
  const bus = { ensureDirs() {}, listPending: () => [], readState: () => ({}), writeState: () => ({}), readAndClearInbox: () => [], inboxCount: () => 0 };
  try {
    await runDaemon({ bus, tg, chatId: '999', now: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
      stop: () => polls >= 3 });
  } finally { console.error = origErr; }
  assert.deepEqual(sleeps, [POLL_409_BACKOFF_MS, POLL_409_BACKOFF_MS, POLL_409_BACKOFF_MS]);
  assert.ok(POLL_409_BACKOFF_MS > POLL_ERROR_BACKOFF_MS);
  const conflictLogs = errors.filter((e) => /another poller|conflict/i.test(e));
  assert.equal(conflictLogs.length, 1, 'the 409 flood is logged ONCE, not per poll');
});
