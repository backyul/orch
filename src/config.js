import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// An isolated instance (e.g. the cockpit GUI) can point at its own state dir via ORCH_STATE_DIR,
// so two daemons on two different bots never share pending/replies/worker state.
export const ORCH_DIR = process.env.ORCH_STATE_DIR
  ? path.resolve(process.env.ORCH_STATE_DIR)
  : path.join(os.homedir(), '.claude', 'orchestrator');
export const PENDING_DIR = path.join(ORCH_DIR, 'pending');
export const REPLIES_DIR = path.join(ORCH_DIR, 'replies');
export const STATE_FILE = path.join(ORCH_DIR, 'state.json');
export const INBOX_DIR = path.join(ORCH_DIR, 'inbox');
export const OUTBOX_DIR = path.join(ORCH_DIR, 'outbox');
export const SESSION_FILE = path.join(ORCH_DIR, 'orch-session.json');

export const IDLE_TIMEOUT_MS = 90_000;
export const MAX_CAPTURE_ATTEMPTS = 5;   // ticks to wait for a permission dialog to render before giving up
export const POLL_TIMEOUT_S = 3;     // telegram long-poll seconds (short = snappy escalation)
export const TICK_INTERVAL_MS = 2_000;
export const NUDGE_REPEAT_MS = 20_000;   // min gap between orchestrator re-nudges (avoid flooding its input)
export const WORKER_REMIND_MS = 120_000; // re-remind orch about a still-blocked worker every ~2 min
export const IDLE_CONFIRM_MS = 8_000;    // a worker must be idle this long before it counts as "blocked" (debounce the brief idle between its own tool calls)
export const PRESENT_TIMEOUT_MS = 10 * 60_000; // no cockpit typing for this long -> auto-away (say re-routes to Telegram)
export const APPROVAL_WAIT_MS = 120_000;        // MCP permission tool waits this long for a button tap
export const APPROVAL_REPING_MS = 2 * 3_600_000; // one reminder about a still-unanswered approval, then silence
export const TURN_TIMEOUT_MS = 15 * 60_000;      // kill a supervisor turn that runs longer than this
export const WATCHDOG_INTERVAL_MS = 60_000;      // min gap between GUI health sweeps
// Headless worker team (spec: docs/superpowers/specs/2026-07-21-headless-worker-team-design.md)
export const WORKER_TURN_CAP = 50;      // auto-continue turns before a worker pauses for triage
export const DIGEST_EVERY_TURNS = 5;    // progress digest to the supervisor every N turns
export const MAX_WORKER_TURNS = 3;      // worker turns in flight at once (box also runs the GUI stack)
// A `say` shown at the terminal escalates to Telegram if the operator shows no terminal activity
// for this long (the backstop that guarantees the nightly nudge reaches the phone).
export const SAY_ESCALATE_MS = Number(process.env.ORCH_SAY_ESCALATE_MS) || 5 * 60_000;
export const POLL_ERROR_BACKOFF_MS = 5_000;
// A 409 Conflict means another poller owns the token RIGHT NOW — hammering getUpdates every 5s
// just floods the log. Back off long; the startup lock (poller-lock.js) prevents our own daemons
// from ever getting here, so this only fires for a foreign/legacy process.
export const POLL_409_BACKOFF_MS = 60_000;
export const BRAIN_TIMEOUT_MS = 60_000;

export function loadEnv(envPath) {
  const out = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID,
    orchMode: process.env.ORCH_MODE,
  };
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, '');
      if (m[1] === 'TELEGRAM_BOT_TOKEN' && !out.botToken) out.botToken = val;
      if (m[1] === 'TELEGRAM_ALLOWED_CHAT_ID' && !out.allowedChatId) out.allowedChatId = val;
      if (m[1] === 'ORCH_MODE' && !out.orchMode) out.orchMode = val;
    }
  } catch { /* no .env file is fine if real env vars set */ }
  return out;
}
