// Telegram getUpdates is EXCLUSIVE per bot token — two pollers on one token fight each other and
// flood both logs with 409 Conflict (the 2.2MB daemon.log.err incident). This lock makes the
// second daemon fail FAST and LOUDLY at startup instead.
//
// The lock lives OUTSIDE ORCH_STATE_DIR on purpose: the terminal daemon and the cockpit GUI
// daemon use different state dirs, but they must still contend when (mis)configured with the
// same token — which is exactly the bug this catches. Keyed by token HASH so the token itself
// never lands on disk in yet another place. ORCH_LOCK_DIR overrides the location (tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = alive but not ours; ESRCH = gone
}

export function pollerLockFile(token, { lockDir } = {}) {
  const dir = lockDir || process.env.ORCH_LOCK_DIR || path.join(os.homedir(), '.claude');
  const key = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
  return path.join(dir, `tg-poller-${key}.lock`);
}

export function acquirePollerLock(token, { lockDir, pid = process.pid } = {}) {
  const file = pollerLockFile(token, { lockDir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (holder.pid !== pid && pidAlive(holder.pid)) return { ok: false, holderPid: holder.pid };
    // stale (dead holder) — fall through and take it over
  } catch { /* no lock yet / unreadable -> acquirable */ }
  const tmp = `${file}.${pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, startedAt: Date.now() }));
  fs.renameSync(tmp, file);
  const release = () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
  return { ok: true, file, release };
}

export function is409Conflict(err) {
  return /terminated by other getUpdates/i.test(String(err && err.message || err));
}
