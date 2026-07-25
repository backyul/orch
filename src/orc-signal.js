// Turns a Claude Code hook event (posted by orc-hook.js from inside each agent) into orchestrator
// coordination. This is the GUI-native equivalent of Nova's orc-hook.sh push signal:
//
//   1. Self-heal — every hook payload carries the LIVE session id. Claude changes that id on
//      /compact, /clear, and resume, which would otherwise leave the resume manifest (agents.json)
//      pointing at a stale id that fails `--resume` on the next host restart. We refresh it here.
//
//   2. Worker -> orchestrator signal — when a WORKER goes idle waiting for input (Notification
//      notification_type 'idle_prompt') or hits a permission prompt, we drop a lightweight
//      'freetext' pending. The daemon's EXISTING triage (daemon.js) then nudges the orchestrator,
//      so a worker's question reaches orch without the operator having to say "check <worker>".
//      The orchestrator's own idle is normal (it waits on the operator inbox), so we never signal
//      for it. Deduped to one outstanding pending per worker to avoid nudge floods.

import { parseSelector } from './selector.js';

const SIGNAL_TYPES = new Set(['idle_prompt', 'permission_prompt']);

// Does the worker's pane show an UNANSWERED prompt (genuinely blocked), as opposed to a worker that
// simply finished a task and is resting at an empty input box? Two positive markers:
//   1. a numbered selector / permission dialog (parseSelector finds >=2 options), or
//   2. the agent's last output line is a question (ends with '?').
// Claude's persistent input-box + hint/mode footer sit BELOW the agent's message, so we skip that
// chrome and test the agent's real final line. Used to gate the turn-end (Stop) signal and the
// daemon's idle-watch, so a done/resting worker stops generating "needs input" tickets. It's a
// heuristic (a question not ending in '?' won't match) — genuine blocks that miss it still reach
// orch via Claude's own idle_prompt/permission Notifications, which always signal.
export function paneShowsPrompt(raw) {
  if (parseSelector(raw)) return true;
  const clean = String(raw || '')
    .replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '')            // CSI
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC
    .replace(/\r/g, '');
  const lines = clean.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
  const isChrome = (l) => {
    const t = l.trim();
    return /^[│╭╮╰╯─>❯·•●◯✳✻✽*\s]*$/.test(t)            // box borders / empty prompt / lone cursor
      || /for shortcuts/i.test(t)                        // "? for shortcuts"
      || /esc to (interrupt|undo|edit)/i.test(t)
      || /bypass(ing)? permissions/i.test(t)
      || /shift\+tab|shift\+enter|ctrl\+/i.test(t);
  };
  let i = lines.length - 1;
  while (i >= 0 && isChrome(lines[i])) i--;
  return i >= 0 && /\?\s*$/.test(lines[i].trim());
}

// Strip ANSI/OSC control sequences and return the last few non-blank lines of a pane capture, so
// the triage note carries the worker's actual question (not just "is waiting").
export function extractTail(raw, { maxLines = 10, maxChars = 500 } = {}) {
  const clean = String(raw || '')
    .replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '')            // CSI (colors, cursor moves)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC (title sets)
    .replace(/\r/g, '');
  const lines = clean.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}

// Create the "worker needs input" pending that the daemon's triage turns into an orch nudge.
// Deduped: one outstanding pending per worker (returns null if one already exists), so neither the
// hook nor the idle-watch can flood orch. `source` tags who created it ('hook' | 'idle-watch').
export function writeWorkerInputPending({ bus, name, text, now = () => Date.now(), source }) {
  if (!bus || !bus.writePending || !bus.listPending) return null;
  if (bus.listPending().some((p) => p.worker === name)) return null;
  const ref = bus.genRef ? bus.genRef(name) : `${name}.${Math.floor(now())}`;
  const rec = { ref, worker: name, type: 'freetext', text, createdAt: now(), ...(source ? { _source: source } : {}) };
  bus.writePending(rec);
  return rec;
}

// deps: { bus, registry, now? }.  payload: { name, event, notificationType, sessionId, message }.
// Never throws — a hook must never break the agent that fired it.
export function handleHookEvent(deps, payload) {
  const { bus, registry, now = () => Date.now() } = deps || {};
  const { name, event, notificationType, sessionId, message } = payload || {};
  const out = { name, selfHealed: false, signaled: false };
  if (!name || !registry || !registry.get) return out;
  const agent = registry.get(name);
  if (!agent) return out;

  if (sessionId && registry.setSessionId) {
    try { out.selfHealed = !!registry.setSessionId(name, sessionId)?.changed; } catch { /* ignore */ }
  }

  const isWorker = agent.role !== 'orchestrator';
  // Two worker signals reach us:
  //  - Notification idle_prompt / permission_prompt: Claude itself reporting it's waiting or hit a
  //    permission gate. Trustworthy — always signal.
  //  - Stop (turn ended): fires whether the worker is genuinely BLOCKED on a question or just
  //    finished a task and is resting at an empty prompt. Stop alone can't tell these apart, so we
  //    read the pane: signal only when it shows an unanswered prompt (paneShowsPrompt). A resting
  //    worker stays quiet — the fix for repeated "needs input" tickets after a completed task.
  const notif = event === 'Notification' && SIGNAL_TYPES.has(notificationType);
  const stop = event === 'Stop';
  if (isWorker && (notif || stop)) {
    let raw = '';
    try { raw = registry.capture ? registry.capture(name) : ''; } catch { raw = ''; }
    if (stop && !notif && !paneShowsPrompt(raw)) return out; // finished a task, resting -> no ticket
    const snippet = extractTail(raw);
    const text = snippet
      ? `is waiting for input — recent output:\n${snippet}`
      : (message || 'is waiting for input');
    out.signaled = !!writeWorkerInputPending({ bus, name, text, now, source: 'hook' });
  }
  return out;
}
