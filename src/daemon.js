import { fileURLToPath } from 'node:url';
import { parseUpdate } from './telegram.js';
import { computeEscalations } from './escalation.js';
import { parseSelector } from './selector.js';
import { POLL_TIMEOUT_S, TICK_INTERVAL_MS, POLL_ERROR_BACKOFF_MS, POLL_409_BACKOFF_MS, MAX_CAPTURE_ATTEMPTS, NUDGE_REPEAT_MS, WORKER_REMIND_MS, IDLE_CONFIRM_MS, PRESENT_TIMEOUT_MS, SAY_ESCALATE_MS, APPROVAL_WAIT_MS, APPROVAL_REPING_MS, MAX_WORKER_TURNS } from './config.js';
import { is409Conflict } from './poller-lock.js';
import { routeAnswer } from './route.js';
import { extractTail, writeWorkerInputPending, paneShowsPrompt } from './orc-signal.js';
import * as defaultTranscript from './transcript.js';
import { readRequest as readApprovalRequest, answerRequest, readAnswer, listRequests as listApprovalRequests, updateRequest as updateApprovalRequest, purgeOld as purgeOldApprovals } from './approvals.js';
import { createTurnQueue } from './turn-queue.js';

// Unified-transcript mirror: best-effort by contract — a disk problem must never break the
// comms path, so every call is swallowed. deps.transcript is injectable for tests.
function mirror(deps, entry) {
  try { (deps.transcript || defaultTranscript).append(entry); } catch { /* mirror only */ }
}

// Send an orch->operator Telegram message AND mirror it into the transcript. Every daemon send
// that the operator sees on their phone goes through here, so the terminal transcript stays
// a complete record of both sides.
async function sendAndLog(deps, text, opts) {
  const messageId = await deps.tg.sendMessage(deps.chatId, text, opts);
  mirror(deps, { ts: (deps.now || Date.now)(), from: 'orch', channel: 'telegram', text });
  return messageId;
}

// Operator activity from Telegram: stamp the channel so `say` (presence.channelFor) follows them.
// lastTelegramAt is a DEDICATED stamp of the operator's most-recent Telegram contact — it gives
// channelFor Telegram-recency authority over a stale cockpit keystroke, and forces sweepOutbox to
// escalate any terminal-shown say that predates it (a phone message means they're NOT at the pane).
function stampTelegram(deps) {
  const t = (deps.now || Date.now)();
  deps.bus.writeState({ lastChannel: 'telegram', lastChannelAt: t, lastTelegramAt: t });
}

// Absolute path to THIS build's cli.js (forward slashes so it works in any shell orch uses). We nudge
// orch with the absolute path, not a bare "src/cli.js": orch tends to `cd` to the main repo, whose
// cli.js/config.js may not honor ORCH_STATE_DIR — so a relative call reads the WRONG inbox and can
// never drain what this daemon wrote, causing an endless re-nudge loop. An absolute path pins orch to
// the state-dir-aware build regardless of its cwd. (Assumes a space-free path, true for this layout.)
const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url)).replace(/\\/g, '/');

const TG_TEXT_MAX = 4096; // Telegram sendMessage hard limit (chars)

export function formatPending(p) {
  // Show the friendly worker name, not the internal ref (routing keys off the Telegram
  // message id / button data, not the visible text).
  return `⚠️ ${p.worker} needs you:\n${p.text}`;
}

// Turn 'permission' pendings into actionable 'options' by reading the permission
// dialog's real choices off the worker's pane. The dialog may not be rendered the
// instant the hook fired, so we retry across ticks; after MAX_CAPTURE_ATTEMPTS we
// fall back to a plain note so the prompt isn't silently lost.
export function enrichPermissions(deps) {
  const { bus, tmux } = deps;
  const state = bus.readState();
  for (const p of bus.listPending()) {
    if (p.type !== 'permission') continue;
    // Prefer the registered (session-qualified) target over the hook's bare pane id,
    // since psmux pane ids collide across sessions.
    const pane = state.workers?.[p.worker] || p.paneId;
    let parsed = null;
    if (pane) { try { parsed = parseSelector(tmux.capturePane(pane)); } catch { parsed = null; } }
    if (parsed && parsed.options.length >= 2) {
      bus.updatePending(p.ref, { type: 'options', text: parsed.question, options: parsed.options });
    } else {
      const attempts = (p.captureAttempts || 0) + 1;
      if (attempts >= MAX_CAPTURE_ATTEMPTS) {
        bus.updatePending(p.ref, { type: 'freetext', text: `${p.text} (couldn't read the choices — please answer at the terminal)` });
      } else {
        bus.updatePending(p.ref, { captureAttempts: attempts });
      }
    }
  }
}

export function buttonsFor(p) {
  if (p.type !== 'options' || !p.options || !p.options.length) return undefined;
  return p.options.map((label, i) => [{ text: label, data: `${p.ref}::${i}` }]);
}

// Two buttons for an orchestrator spawn-request: approve (spawn) or dismiss.
export function spawnButtons(p) {
  return [
    [{ text: `Approve & spawn ${p.proposedName}`, data: `${p.ref}::approve` }],
    [{ text: 'Dismiss', data: `${p.ref}::dismiss` }],
  ];
}

// Keep phone messages tidy — truncate over-long option text in confirmations.
export function shorten(text, max = 60) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max).trimEnd()}…`;
}

// Telegram sendMessage hard-caps at 4096 chars — chunk long supervisor replies.
export function chunkText(s, max = TG_TEXT_MAX) {
  let t = String(s || '').trim();
  if (!t) return ['(empty reply)'];
  const out = [];
  while (t.length > max) { out.push(t.slice(0, max)); t = t.slice(max); }
  out.push(t);
  return out;
}

// A worker's permission request, briefed to the supervisor (spec: escalations go to the
// supervisor; only operator-grade asks continue to the phone via team-escalate).
export function workerApprovalNote(r) {
  return `Worker "${r.worker}" requests permission:\n${r.toolName}: ${shorten(JSON.stringify(r.input), 300)}\n` +
    `Decide it yourself now:  node ${CLI_PATH} team-approve ${r.id} allow   (or deny)\n` +
    `ONLY if the operator must decide (destructive/external/outside standing rules):  node ${CLI_PATH} team-escalate ${r.id}\n` +
    `The worker is parked on this one action; unanswered requests deny-by-silence after the wait window.`;
}

// One line of supervisor briefing per team event. Terminal events carry the reply tail
// (the DONE:/BLOCKED: substance) + the branch so the supervisor can review/merge/redirect.
export function teamEventNote(worker, ev, reply) {
  const tail = shorten(String(reply || ''), 1500);
  const head = {
    digest: `[team] Worker "${worker.name}" progress digest (turn ${worker.turnCount}):`,
    done: `[team] Worker "${worker.name}" reports DONE (branch ${worker.branch}) — review the branch, then merge or team-send feedback; retire when merged:`,
    blocked: `[team] Worker "${worker.name}" is BLOCKED — unblock via team-send, answer its need, or retire it:`,
    paused: `[team] Worker "${worker.name}" hit the ${worker.turnCount}-turn cap and is PAUSED — team-send to continue (fresh budget), split the task, or retire:`,
  }[ev.type] || `[team] Worker "${worker.name}" event ${ev.type}:`;
  return `${head}\n${tail}`;
}

// Advance active workers, ≤ MAX_WORKER_TURNS in flight. Fire-and-forget per worker: the
// tick must never block on a multi-minute claude turn. Results/failures come back through
// the turn queue. First failure = silent retry next sweep; second = error + supervisor turn.
export async function sweepTeam(deps) {
  if (!deps.team || !deps.turnQueue) return;
  deps._teamInflight ||= new Set();
  deps._teamFails ||= new Map();
  for (const w of deps.team.listWorkers()) {
    if (w.status !== 'active' || deps._teamInflight.has(w.name)) continue;
    if (deps._teamInflight.size >= MAX_WORKER_TURNS) break;
    deps._teamInflight.add(w.name);
    deps.team.runTurn(w.name)
      .then((r) => {
        deps._teamFails.delete(w.name);
        if (!r) return;
        for (const ev of r.events) deps.turnQueue.push('team', teamEventNote(r.worker, ev, r.reply));
      })
      .catch((err) => {
        try {
          const n = (deps._teamFails.get(w.name) || 0) + 1;
          deps._teamFails.set(w.name, n);
          if (n >= 2) {
            deps._teamFails.delete(w.name);
            deps.team.markError(w.name, String(err?.message || err));
            deps.turnQueue.push('team', `[team] Worker "${w.name}" turn failed twice and was marked ERROR: ` +
              `${shorten(String(err?.message || err), 400)}. Investigate (team-status, its worktree/log), then team-send to relaunch or retire it.`);
          }
        } catch (e) {
          console.error('[daemon] team error-path failed:', e.message);
        }
      })
      .finally(() => deps._teamInflight.delete(w.name));
  }
}

// Worker-event prompt for the supervisor (the headless counterpart of triageNote).
export function supervisorWorkerNote(p) {
  const opts = p.options?.length ? ` Options: [${p.options.join(' | ')}].` : ' (free-text answer).';
  return `Worker "${p.worker}" needs input: "${p.text}".${opts}\n` +
    `Either answer it:  node ${CLI_PATH} answer ${p.ref} "<choice>"\n` +
    `…or, if nothing is needed (worker just finished / idle without a task):  node ${CLI_PATH} dismiss ${p.ref}\n` +
    `…or, ONLY if the operator must decide, put the question in your reply.`;
}

// Build the turn queue that connects supervisor turns to the Telegram reply path.
export function initSupervisorQueue(deps) {
  deps._supFailStreak = deps._supFailStreak ?? 0;
  deps.turnQueue = createTurnQueue({
    runTurn: async (prompt) => {
      const { reply } = await deps.supervisor.ask(prompt);
      deps._supFailStreak = 0; // successful turn — reset the consecutive-failure counter
      // Delivery is decoupled from execution: a Telegram hiccup here must retry the SEND,
      // never re-run the turn (its side effects — commits, restarts — are not idempotent).
      for (const c of chunkText(reply)) {
        try { await sendAndLog(deps, c); }
        catch {
          await new Promise((r) => setTimeout(r, deps._retrySendDelayMs ?? 2000));
          try { await sendAndLog(deps, c); }
          catch (e2) {
            // Reply lost to the phone but not to history: mirror it so `cli.js transcript` has it.
            mirror(deps, { ts: (deps.now || Date.now)(), from: 'orch', channel: 'telegram', text: `[UNDELIVERED reply] ${c}` });
            console.error('[daemon] supervisor reply delivery failed (turn NOT retried):', e2.message);
            break;
          }
        }
      }
    },
    onError: async (err) => {
      deps._supFailStreak = (deps._supFailStreak ?? 0) + 1;
      // Two consecutive onError events (= 4 failed turns in a row) mean the session is
      // chronically broken (e.g. 43 MB session file causing TURN_TIMEOUT_MS on every resume).
      // Archive it now so the NEXT turn starts fresh — the channel must never stay dead.
      if (deps._supFailStreak >= 2) {
        if (typeof deps.supervisor?.reset === 'function') deps.supervisor.reset();
        deps._supFailStreak = 0;
        try {
          await sendAndLog(deps,
            `⚠️ Supervisor turn failures repeated (2 consecutive): ` +
            `rotated to a fresh session — context will be fresh. Last error: ${String(err?.message || err).slice(0, 200)}`);
        } catch { /* channel down — poll loop will log */ }
      } else {
        try { await sendAndLog(deps, `⚠️ Supervisor turn failed twice: ${String(err?.message || err).slice(0, 300)}`); }
        catch { /* channel down — poll loop will log */ }
      }
    },
  });
  return deps.turnQueue;
}

// Message new approval requests (Allow/Deny buttons); one re-ping for stale ones; purge done.
// A send failure must never abort the tick (Telegram outages would kill escalations every 2s):
// log once per failure streak, keep the request (messageId stays unset -> retried next tick),
// and return without throwing so the rest of tick always runs.
export async function sweepApprovals(deps) {
  if (!deps.supervisor || !deps.orchDir) return;
  const now = deps.now || (() => Date.now());
  for (const r of listApprovalRequests(deps.orchDir)) {
    if (r.answered) continue;
    // Worker-tagged requests go to the SUPERVISOR (one turn), not to the phone —
    // unless the supervisor escalated them (team-escalate sets escalated:true).
    if (r.worker && !r.escalated) {
      if (!r.supervisorNotified && deps.turnQueue) {
        deps.turnQueue.push('team approval', workerApprovalNote(r));
        updateApprovalRequest(deps.orchDir, r.id, { supervisorNotified: true });
      }
      continue;
    }
    try {
      const who = r.worker ? `Worker "${r.worker}"` : 'Supervisor';
      if (!r.messageId) {
        const messageId = await sendAndLog(deps,
          `🔐 ${who} wants to run:\n${r.toolName}: ${shorten(JSON.stringify(r.input), 300)}`,
          { buttons: [[{ text: 'Allow', data: `apv::${r.id}::allow` }, { text: 'Deny', data: `apv::${r.id}::deny` }]] });
        updateApprovalRequest(deps.orchDir, r.id, { messageId });
      } else if (!r.repinged && now() - r.ts >= APPROVAL_REPING_MS) {
        await sendAndLog(deps, `⏳ Still waiting on Allow/Deny for: ${r.toolName} ${shorten(JSON.stringify(r.input), 120)} (buttons above).`);
        updateApprovalRequest(deps.orchDir, r.id, { repinged: true });
      }
      deps._apvFailing = false;
    } catch (err) {
      if (!deps._apvFailing) {
        console.error('[daemon] approval message send failed (request kept, will retry):', err.message);
        deps._apvFailing = true;
      }
      return; // Telegram down — keep requests for the next tick; the REST of tick must still run
    }
  }
  purgeOldApprovals(deps.orchDir, { now });
}

export function nudgeOrchestrator(deps) {
  const { bus, tmux } = deps;
  const state = bus.readState();
  const pane = state.workers?.[state.orchestratorWorker];
  if (!pane) return false;
  try {
    // Plain ASCII only — emoji / em-dashes / backticks corrupt tmux send-keys into the TUI.
    tmux.sendKeys(pane, `New orchestrator message. Run: node ${CLI_PATH} inbox  then act on it per your role.`);
    deps._lastNudgeAt = (deps.now || Date.now)(); // stamp so tick rate-limits the next re-nudge
    return true;
  } catch { return false; }
}

export function triageNote(p) {
  const opts = p.options?.length ? ` Options: [${p.options.join(' | ')}].` : ' (free-text answer).';
  return `Worker "${p.worker}" needs input: "${p.text}".${opts}\n` +
    `Per your standing rules, either resolve it yourself:  node ${CLI_PATH} answer ${p.ref} "<choice>"\n` +
    `…or, if it needs my decision, ask me via AskUserQuestion. Use "node ${CLI_PATH} say" to update me if useful.\n` +
    `If NOTHING is needed (the worker simply finished, or is idle with no task), clear the flag with:  node ${CLI_PATH} dismiss ${p.ref}\n` +
    `— it will not re-fire until that worker works again, so dismissing is how you end the reminders.`;
}

// True while a turn is generating. Two things matter here:
//  1) WHERE to look — the capture is a byte-LOG that still contains every overwritten spinner frame
//     from scrollback, so scanning the whole thing false-positives on stale "(3s…" / "Running…"
//     text long after the agent went idle. Claude's live status always sits at the BOTTOM, so we
//     look only at the last ~12 non-blank lines (the current render), not the history.
//  2) WHAT marks busy — "esc to interrupt" is canonical, but while running a tool Claude may show
//     only its live spinner: an elapsed-seconds counter in parens like "Spelunking… (48s · …)" or a
//     "Running N shell command" line. The completed-turn summary "Baked for 4m 47s" has NO leading
//     "(", so it reads idle. Erring toward busy is the safe bias: a false-busy skips a nudge, a
//     false-idle spams the orchestrator.
export function isAgentBusy(paneText) {
  const clean = String(paneText || '').replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '').replace(/\r/g, '');
  const tail = clean.split('\n').filter((l) => l.trim()).slice(-12).join('\n');
  return /esc to interrupt/i.test(tail)
    || /\(\d+s\b/.test(tail)                        // live spinner elapsed counter, e.g. "(48s ·"
    || /Running \d+ (shell command|tool)/i.test(tail);
}

// Token-free worker surveillance: capture each worker pane (reads terminal bytes, not Claude) and,
// when a worker sits idle waiting for input, drop a pending so the EXISTING triage nudges orch —
// the reliable trigger that doesn't depend on Claude firing its own idle-notification hook. Deduped
// to one outstanding signal per worker; the signal is cleared when the worker goes busy again, so
// the next idle re-signals. The orchestrator itself is never surveilled (it waits on its inbox).
export function detectWorkerInput(deps) {
  const { bus } = deps;
  const now = deps.now || (() => Date.now());
  const state = bus.readState();
  const orchWorker = state.orchestratorWorker;
  deps._idleSince = deps._idleSince || {};       // per-worker: when we first saw it idle (debounce)
  deps._signaledEpisode = deps._signaledEpisode || {}; // per-worker: already signaled THIS idle episode
  for (const [name, pane] of Object.entries(state.workers || {})) {
    if (!name || !pane || name === orchWorker) continue;
    let text = '';
    try { text = deps.tmux.capturePane(pane); } catch { continue; } // pane gone / capture failed
    if (isAgentBusy(text)) {
      // Working now -> reset the idle timer AND the episode latch, and clear any stale "needs
      // input" flag (both signal sources: daemon idle-watch + Claude-hook) — never
      // permission/spawn/options pendings.
      delete deps._idleSince[name];
      delete deps._signaledEpisode[name];
      const mine = bus.listPending().find((p) => p.worker === name && (p._source === 'idle-watch' || p._source === 'hook'));
      if (mine) bus.removePending(mine.ref);
      continue;
    }
    // Idle — but only signal once idle is SUSTAINED (brief idle between a worker's own tool calls
    // resolves itself), and only ONCE PER EPISODE (edge-triggered on the busy->idle transition).
    // Without the episode latch, a worker that is idle because it FINISHED (or has no task) gets
    // re-flagged forever after orch dismisses the flag — orch can never say "nothing needed".
    if (deps._idleSince[name] === undefined) { deps._idleSince[name] = now(); continue; }
    if (now() - deps._idleSince[name] < IDLE_CONFIRM_MS) continue;
    if (deps._signaledEpisode[name]) continue; // already signaled (or adopted a hook signal) this episode
    // Idle is not the same as blocked. A worker that just FINISHED a task rests at an empty prompt;
    // only escalate when the pane actually shows an unanswered prompt (a selector/permission dialog
    // or a trailing question). This is what stops a done worker from generating "needs input"
    // tickets. A genuinely blocked worker that this heuristic misses still reaches orch via Claude's
    // idle_prompt/permission Notification (handled in orc-signal, which always signals).
    if (!paneShowsPrompt(text)) {
      // Resting, not blocked -> no ticket. Clear any stale idle-watch flag so the remind loop goes
      // quiet; never touch a hook/permission/options pending (those are real questions).
      const stale = bus.listPending().find((p) => p.worker === name && p._source === 'idle-watch');
      if (stale) bus.removePending(stale.ref);
      continue;
    }
    deps._signaledEpisode[name] = true; // latch even if a hook pending already exists (it IS this episode's signal)
    const snippet = extractTail(text);
    writeWorkerInputPending({
      bus, name, now, source: 'idle-watch',
      text: snippet ? `is idle, waiting for input — recent output:\n${snippet}` : 'is idle, waiting for input',
    });
  }
}

// Escalate terminal-shown `say` messages that the operator never saw. `say` drops each one in the
// outbox with its shownAt; terminal activity AFTER shownAt (typing heartbeat / lastChannelAt)
// means "seen — drop silently"; no activity within SAY_ESCALATE_MS means "push to the phone".
// Due entries are batched into ONE Telegram message; a failed send keeps them for the next tick.
// This is the structural fix for the lost 23:03 nudges: even with every presence flag wrong,
// a say reaches Telegram within the timeout.
export async function sweepOutbox(deps) {
  const { bus, chatId } = deps;
  const now = deps.now || (() => Date.now());
  const entries = bus.listOutbox();
  if (!entries.length) return;
  const st = bus.readState();
  const seenAt = Math.max(st.lastChannel === 'terminal' ? (st.lastChannelAt || 0) : 0, st.presentAt || 0);
  const lastTelegramAt = st.lastTelegramAt || 0;
  const due = [];
  for (const e of entries) {
    // "seen at the terminal" only counts if NO Telegram message arrived after the say was shown.
    // A phone message after e.shownAt means the operator is on Telegram, not reading the pane — so
    // ongoing cockpit-presence stamping must NOT mark that say as seen; it still escalates.
    if (seenAt > e.shownAt && lastTelegramAt <= e.shownAt) { bus.removeOutbox(e.id); continue; }
    if (now() - e.shownAt >= SAY_ESCALATE_MS) due.push(e);
  }
  if (!due.length) return;
  // Telegram sendMessage hard-caps text at 4096 chars. Batching everything into ONE message
  // wedged the sweep permanently once the backlog crossed the cap (send throws -> entries kept ->
  // backlog only grows -> throws forever, silently). So: chunk to the cap, truncate any single
  // over-long entry (full text stays in the transcript), and remove entries PER successful chunk
  // so partial progress sticks. A failed send stops the sweep (retry next tick) and is logged
  // once per failure streak — never silent again.
  const header = '📟 ';
  const SEP = '\n—\n';
  const room = TG_TEXT_MAX - header.length;
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const e of due) {
    let t = e.text;
    if (t.length > room) t = `${t.slice(0, room - 60)}\n… (truncated — full text: cli.js transcript)`;
    const addLen = (cur.length ? SEP.length : 0) + t.length;
    if (cur.length && curLen + addLen > room) { chunks.push(cur); cur = []; curLen = 0; }
    curLen += (cur.length ? SEP.length : 0) + t.length;
    cur.push({ id: e.id, text: t });
  }
  if (cur.length) chunks.push(cur);
  for (const chunk of chunks) {
    try {
      await sendAndLog(deps, header + chunk.map((c) => c.text).join(SEP));
      for (const c of chunk) bus.removeOutbox(c.id);
      deps._sweepFailing = false;
    } catch (err) {
      if (!deps._sweepFailing) {
        console.error('[daemon] outbox escalation send failed (entries kept, will retry):', err.message);
        deps._sweepFailing = true;
      }
      return; // keep this chunk + the rest for the next tick
    }
  }
}

export async function tick(deps) {
  const { bus, tg, chatId, now, refMap } = deps;
  enrichPermissions(deps); // permission -> options (reads dialog choices off the pane)
  detectWorkerInput(deps); // idle worker -> pending (so computeEscalations below picks it up)
  // Outbox sweep (guarded: older/minimal bus fakes may lack outbox support).
  if (typeof bus.listOutbox === 'function') await sweepOutbox(deps);
  // AUTO-AWAY: cockpit-typing presence EXPIRES. presentAt is the host's typing heartbeat; when it
  // goes stale the operator has walked away, so flip away=true and let `say` reach the phone again.
  // A manual /back (no presentAt heartbeat afterwards) still expires from its own presentAt-less
  // baseline only when a heartbeat existed; /back with no typing ever = sticky by design.
  {
    const st = bus.readState();
    if (st.away !== true && st.presentAt && now() - st.presentAt > PRESENT_TIMEOUT_MS) {
      bus.writeState({ away: true, awaySetAt: now() });
    }
  }
  // Supervisor mode: GUI watchdog (cheap checks; alerts become turns) + approval messaging.
  if (deps.watchdog && deps.turnQueue) {
    for (const a of await deps.watchdog()) deps.turnQueue.push('watchdog', a);
  }
  if (deps.supervisor) await sweepApprovals(deps);
  if (deps.team) await sweepTeam(deps);
  // Wall-clock schedules (daemon-side — see schedules.js): a due entry drops its message into the
  // orchestrator inbox and nudges, so "at 23:03 ask the operator X" fires whether or not the
  // orchestrator's own session was awake at that minute (agent-side crons silently miss).
  if (deps.schedules) {
    const fired = deps.schedules.fireDue(new Date(now()));
    for (const s of fired) {
      const msg = s.missed ? `MISSED schedule (${s.time} daily): the daemon was down at ${s.time} on ${s.missedDate} and the catch-up window has passed, so it was NOT auto-run — tell the operator it was missed. Message was: ${s.message}`
        : s.late ? `Scheduled (${s.time} daily — firing LATE, the daemon was down at ${s.time} on ${s.missedDate}): ${s.message}`
        : `Scheduled (${s.time} daily): ${s.message}`;
      if (deps.turnQueue) deps.turnQueue.push('schedule', msg);
      else bus.writeInbox(msg);
    }
    if (fired.length && !deps.turnQueue) nudgeOrchestrator(deps);
  }
  const state = bus.readState();
  const pending = bus.listPending();
  const esc = computeEscalations({ pending, state, now: now() });
  const orchWorker = state.orchestratorWorker;
  const orchPane = state.workers?.[orchWorker];
  for (const e of esc) {
    const p = bus.readPending(e.ref);
    if (!p) continue;
    if (p.type === 'spawn-request') {
      // orchestrator proposes a new worker -> ask the operator with Approve & spawn / Dismiss
      const messageId = await sendAndLog(deps,
        `🤖 orch proposes spawning worker "${p.proposedName}".\n${p.why || ''}`.trim(),
        { buttons: spawnButtons(p) });
      bus.updatePending(e.ref, { escalatedAt: now(), messageId });
      refMap.set(messageId, e.ref);
    } else if (p.worker === orchWorker) {
      // the orchestrator's OWN question -> escalate to the user with buttons
      const messageId = await sendAndLog(deps, formatPending(p), { buttons: buttonsFor(p) });
      bus.updatePending(e.ref, { escalatedAt: now(), messageId });
      refMap.set(messageId, e.ref);
    } else if (deps.turnQueue) {
      // Supervisor mode: the worker question becomes a turn — no pane, no nudge.
      deps.turnQueue.push('worker', supervisorWorkerNote(p));
      bus.updatePending(e.ref, { escalatedAt: now() });
    } else if (orchPane) {
      // a worker question -> triage to the orchestrator (inbox + nudge)
      bus.writeInbox(triageNote(p));
      nudgeOrchestrator(deps);
      bus.updatePending(e.ref, { escalatedAt: now() }); // mark handed off
    } else if (!p.orchDownNotified) {
      // orchestrator isn't running -> tell the user once (no silent stranding)
      await sendAndLog(deps, `⚠️ "${p.worker}" needs input but the orchestrator isn't running. ` +
        `Start it (./start-orchestrator.ps1) or answer at the terminal.\n"${p.text}"`);
      bus.updatePending(e.ref, { orchDownNotified: true });
    }
  }
  // Reconcile: an escalated question that vanished was resolved locally. Collapse the original
  // question message IN PLACE (no new note, no duplicates). Deliberately NOT a presence signal:
  // orch itself answers/dismisses pendings all day, so "a pending vanished" says nothing about
  // where the OPERATOR is — treating it as operator-at-terminal silently re-routed `say` away
  // from the phone (2026-07-14 incident). Genuine presence comes only from the typing marker.
  for (const [messageId, ref] of refMap) {
    if (bus.readPending(ref) === null) {
      try { await tg.editMessageText(chatId, messageId, '✅ Resolved at the terminal.'); } catch { /* best-effort */ }
      refMap.delete(messageId);
    }
  }
  // Re-nudge the orchestrator until it drains the inbox. The single nudge on write can be missed
  // if the agent was mid-turn, leaving messages stranded; retry while the pane is idle. Rate-limited
  // to NUDGE_REPEAT_MS so a stuck/unresponsive orch isn't flooded — rapid nudges get coalesced by
  // the TUI into one un-submitted multi-line input, which is worse than waiting.
  if (orchPane && bus.inboxCount() > 0 && (now() - (deps._lastNudgeAt || 0)) >= NUDGE_REPEAT_MS) {
    let busy = true;
    try { busy = isAgentBusy(deps.tmux.capturePane(orchPane)); } catch { busy = true; }
    if (!busy) nudgeOrchestrator(deps); // stamps _lastNudgeAt itself
  }
  // Re-remind orch about worker questions it read but didn't resolve. A single triage note can be
  // drained-and-ignored; while the worker stays blocked (its signal pending is still outstanding —
  // detectWorkerInput clears it the moment the worker resumes work), re-triage on a cooldown so the
  // question isn't stranded. Only when orch is idle (don't pile into a mid-turn input) and only for
  // worker signals (never orch's own operator-facing escalations, which would double-ping the user).
  if (orchPane) {
    const stalledWorkerQs = pending.filter((p) => p.worker !== orchWorker
      && (p._source === 'idle-watch' || p._source === 'hook')
      && p.escalatedAt && (now() - p.escalatedAt) >= WORKER_REMIND_MS);
    if (stalledWorkerQs.length) {
      let orchIdle = false;
      try { orchIdle = !isAgentBusy(deps.tmux.capturePane(orchPane)); } catch { orchIdle = false; }
      if (orchIdle) {
        for (const p of stalledWorkerQs) {
          bus.writeInbox(triageNote(p));
          bus.updatePending(p.ref, { escalatedAt: now() });
        }
        nudgeOrchestrator(deps);
      }
    }
  }
  // Telegram "typing…": while the operator is away (on their phone) and the orchestrator is actively
  // generating, keep the chat from going silent between the operator's message and orch's reply.
  // Telegram's action lasts ~5s, so re-send at most every ~4s. When the operator is present, orch's
  // replies show in the pane (not Telegram), so no indicator is needed.
  if (orchPane && tg.sendChatAction && bus.readState().away === true &&
      (deps._lastTypingAt === undefined || (now() - deps._lastTypingAt) >= 4000)) {
    let orchBusy = false;
    try { orchBusy = isAgentBusy(deps.tmux.capturePane(orchPane)); } catch { orchBusy = false; }
    if (orchBusy) {
      deps._lastTypingAt = now();
      Promise.resolve(tg.sendChatAction(chatId, 'typing')).catch(() => {}); // best-effort, never blocks the tick
    }
  }
}

async function deliverReply(p, answer, source, deps) {
  const { tg, chatId, refMap } = deps;
  const { delivered } = routeAnswer(p, answer, source, deps);
  if (p.messageId != null) refMap.delete(p.messageId);
  if (!delivered) {
    await tg.sendMessage(chatId, `⚠️ Couldn't deliver your answer to ${p.ref} — its pane is gone. Your answer was: "${answer}"`);
  }
  return delivered;
}

function statusText(bus) {
  const st = bus.readState();
  const pend = bus.listPending();
  const lines = [`away: ${st.away ? 'yes' : 'no'}`, `pending questions: ${pend.length}`];
  for (const x of pend) lines.push(`  ${x.ref} (${x.worker}): ${String(x.text).slice(0, 60)}`);
  return lines.join('\n');
}


export async function handleUpdate(update, deps) {
  const { bus, tg, chatId, refMap } = deps;
  const u = parseUpdate(update);
  if (String(u.chatId) !== String(chatId)) return; // allowlist

  if (u.kind === 'callback') {
    stampTelegram(deps); // a button tap is operator activity on the phone

    // Supervisor approval buttons: apv::<id>::allow|deny — answer the MCP handshake file.
    if (String(u.data || '').startsWith('apv::')) {
      if (!deps.orchDir) { await tg.answerCallback(u.callbackId, 'Not available'); return; } // legacy daemon: consume the stray tap
      const [, apvId, verdict] = String(u.data).split('::');
      if (!apvId || (verdict !== 'allow' && verdict !== 'deny')) { await tg.answerCallback(u.callbackId, 'Ignored'); return; } // malformed data: never write a deny for an empty/garbage id
      const allow = verdict === 'allow';
      // Idempotency: Telegram redelivers callbacks and operators double-tap. Re-writing the same
      // verdict is harmless, but the late "proceed" TURN below must fire at most once — a duplicate
      // turn re-executes exactly the risky action the approval gated.
      const priorAnswer = readAnswer(deps.orchDir, apvId);
      answerRequest(deps.orchDir, apvId, allow, deps.now);
      const req = readApprovalRequest(deps.orchDir, apvId);
      mirror(deps, { ts: deps.now(), from: 'operator', channel: 'telegram', text: `[button] ${allow ? 'Allow' : 'Deny'} ${req?.toolName || apvId}` });
      // If the turn that asked already timed out (MCP returned PENDING), tell the ASKER it may
      // now proceed — a fresh turn/queue entry, since the original one has ended.
      if (!priorAnswer && allow && req && (deps.now() - req.ts) > APPROVAL_WAIT_MS) {
        if (req.worker) {
          // The parked action belongs to the WORKER (its MCP turn already returned PENDING):
          // requeue the worker, don't brief the supervisor about an action it never requested.
          try { deps.team?.sendToWorker(req.worker, `Your earlier permission request (${req.toolName}) was APPROVED — you may retry that action now.`); } catch { /* worker retired — nothing to requeue */ }
        } else if (deps.turnQueue) {
          deps.turnQueue.push('approval', `Operator APPROVED the previously-pending action: ` +
            `${req.toolName} ${shorten(JSON.stringify(req.input), 300)}. Proceed with it now.`);
        }
      }
      if (u.refMessageId != null) {
        try { await tg.editMessageText(chatId, u.refMessageId, allow ? '✅ Allowed' : '❌ Denied'); } catch { /* best-effort */ }
      }
      await tg.answerCallback(u.callbackId, allow ? 'Allowed' : 'Denied');
      return;
    }

    const [ref, idxStr] = String(u.data || '').split('::');
    const p = bus.readPending(ref);
    if (p && p.type === 'spawn-request') {
      mirror(deps, { ts: deps.now(), from: 'operator', channel: 'telegram', text: `[button] ${idxStr === 'approve' ? `Approve & spawn ${p.proposedName}` : 'Dismiss'}` });
      // Approve -> spawn the proposed worker via the host; Dismiss -> just clear.
      if (idxStr === 'approve' && deps.hostClient) await deps.hostClient.spawn(p.proposedName);
      bus.removePending(ref);
      if (p.messageId != null) refMap.delete(p.messageId);
      if (u.refMessageId != null) {
        try { await tg.editMessageText(chatId, u.refMessageId, idxStr === 'approve' ? `✅ Spawned "${p.proposedName}"` : '❌ Dismissed'); } catch { /* best-effort */ }
      }
      await tg.answerCallback(u.callbackId, idxStr === 'approve' ? 'Spawning' : 'Dismissed');
      return;
    }
    if (p) {
      const answer = p.options?.[Number(idxStr)] ?? '';
      mirror(deps, { ts: deps.now(), from: 'operator', channel: 'telegram', text: `[button] ${answer}` });
      await deliverReply(p, answer, 'telegram', deps);
      // Collapse the buttons and show the chosen option in the original message.
      if (u.refMessageId != null) {
        try { await tg.editMessageText(chatId, u.refMessageId, `✅ You chose: ${shorten(answer)}`); } catch { /* edit is best-effort */ }
      }
    }
    await tg.answerCallback(u.callbackId, p ? 'Got it' : 'Already handled');
    return;
  }

  if (u.kind === 'reply') {
    const ref = refMap.get(u.replyToMessageId);
    const p = ref ? bus.readPending(ref) : null;
    if (p) {
      stampTelegram(deps);
      mirror(deps, { ts: deps.now(), from: 'operator', channel: 'telegram', text: u.text });
      await deliverReply(p, u.text, 'telegram', deps);
      return;
    }
    // not a known escalation -> fall through to NL handling below
  }

  const text = String(u.text || '').trim();
  if (text === '/away') {
    bus.writeState({ away: true, awaySetAt: deps.now() });
    await tg.sendMessage(chatId, '🔕 Away — worker questions will escalate immediately.');
    return;
  }
  if (text === '/back') {
    // Manual override: "treat me as at the terminal" — must also reset lastChannel, else the
    // telegram-last stamp from this very message would keep routing `say` to the phone.
    bus.writeState({ away: false, lastChannel: 'terminal', lastChannelAt: deps.now() });
    await tg.sendMessage(chatId, '✅ Back — escalations paused (idle-timeout still applies).');
    return;
  }
  if (text === '/status') {
    await tg.sendMessage(chatId, statusText(bus));
    return;
  }
  if (text === '/reset' && deps.supervisor) {
    deps.supervisor.reset();
    await tg.sendMessage(chatId, '🔄 Session rotated — a fresh Supervisor session starts with your next message.');
    return;
  }
  // plain text -> the operator is on their phone: mark AWAY and stamp lastChannel so `say`
  // replies go to Telegram. Typing shows instantly; the tick loop keeps it alive. lastTelegramAt
  // records this explicit phone contact so it outranks any stale cockpit keystroke (channelFor)
  // and forces escalation of earlier terminal-shown says (sweepOutbox).
  bus.writeState({ away: true, lastChannel: 'telegram', lastChannelAt: deps.now(), lastTelegramAt: deps.now() });
  mirror(deps, { ts: deps.now(), from: 'operator', channel: 'telegram', text });
  if (tg.sendChatAction) {
    deps._lastTypingAt = deps.now();
    Promise.resolve(tg.sendChatAction(chatId, 'typing')).catch(() => {});
  }
  if (deps.supervisor && deps.turnQueue) {
    // Supervisor mode: the message IS the turn — no pane, no keystrokes, no stranding.
    deps.turnQueue.push('operator message', text);
    return;
  }
  bus.writeInbox(`From you (Telegram): ${text}`);
  if (!nudgeOrchestrator(deps)) {
    await tg.sendMessage(chatId, '⚠️ Orchestrator isn\'t running. Start it with ./start-orchestrator.ps1');
  }
}

export async function runDaemon(deps) {
  const { bus, tg, now } = deps;
  bus.ensureDirs();
  const refMap = deps.refMap = new Map();
  for (const p of bus.listPending()) if (p.messageId) refMap.set(p.messageId, p.ref);
  if (deps.supervisor && !deps.turnQueue) initSupervisorQueue(deps);
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const stop = deps.stop || (() => false); // injectable loop exit (tests); production never stops
  let offset = 0;
  let lastTick = 0;
  let in409 = false; // log the 409 state CHANGE once, not every poll cycle (the old log flood)
  for (;;) {
    if (stop()) return;
    try {
      const { updates, nextOffset } = await tg.getUpdates(offset, POLL_TIMEOUT_S);
      offset = nextOffset;
      in409 = false;
      for (const up of updates) {
        try { await handleUpdate(up, deps); } catch (e) { console.error('[daemon] update error:', e.message); }
      }
    } catch (e) {
      if (is409Conflict(e)) {
        // Another poller owns this token (foreign/legacy process — our own daemons are excluded
        // by the startup lock). Say it once, then back off long instead of flooding the log.
        if (!in409) { console.error('[daemon] 409 Conflict: another poller is running against this bot token — backing off. Find it with: Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'"'); in409 = true; }
        await sleep(POLL_409_BACKOFF_MS);
      } else {
        in409 = false;
        console.error('[daemon] poll error:', e.message);
        await sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
    const t = now();
    if (t - lastTick >= TICK_INTERVAL_MS) {
      lastTick = t;
      try { await tick(deps); } catch (e) { console.error('[daemon] tick error:', e.message); }
    }
  }
}
