# Telegram Supervisor — Headless Claude on mybot_cli

**Status:** design approved in conversation, pending user review of this document.

## Goal

Replace the CLI stack's TUI orchestrator pane with a **headless, persistent Claude Code
session** ("the supervisor") that the user reaches through the existing mybot_cli Telegram
bot. Priorities, in order:

1. **A direct channel to Claude on Telegram.** The user texts; the supervisor answers and
   acts, with full tools, from the phone.
2. **Supervision of the GUI cockpit.** Watch the GUI stack (PTY host :7610, GUI daemon,
   agents), diagnose failures, fix them — restart, edit code, commit — and report.
3. **CLI worker orchestration** (psmux panes) — retained capability, side function.

Day-to-day interactive work stays in normal terminal Claude Code sessions. The supervisor
is the away-channel and standing guardian.

Out of scope: any change to the GUI stack itself (its bot `.env.gui`, its state dir, its
daemon, its host). The headless/SDK rebuild of *worker* channels is a separate future
project.

## Why headless (vs the current TUI orch pane)

Every reliability failure we hit — stranded input, Enter-retry dances, pretype confusing
presence detection, TUI hangs, capture parsing — came from **keystroke injection into a
TUI**. A headless session eliminates that channel entirely:

- **In:** events are prompt turns (`claude -p --resume` with the text on stdin). Nothing
  can strand.
- **Out:** stdout is the reply — clean text for a chat bubble. No pane, no ANSI parsing.
- **Tools:** the supervisor runs `tmux send-keys` / `capture-pane`, `node src/cli.js …`,
  git, tests, and `restart-host.ps1` itself — as tool calls, not as text typed into its
  own terminal.

`src/architect.js` already proves the pattern in this repo (persistent headless session,
stdin prompts, persona file, session-id persistence, injectable runner for hermetic
tests). The supervisor generalizes it.

## Architecture

```
Telegram (mybot_cli)                       ~/.claude/orchestrator (CLI state dir)
      │  long-poll                                   ▲
      ▼                                              │ state/pending/schedules
┌──────────────────────── daemon (evolved) ────────────────────────┐
│ • Telegram poller (existing, chat-id gated)                      │
│ • Watchdog: cheap mechanical GUI-health checks in plain code     │
│ • Schedules: wall-clock HH:MM firing (existing)                  │
│ • Worker hook intake: /api/hook pendings (existing)              │
│ • Turn queue: serialize events → one supervisor turn at a time   │
│ • Approvals bridge: permission requests ↔ Telegram buttons       │
└───────────────┬──────────────────────────────────────────────────┘
                │ claude -p --resume <sid>  (prompt via stdin)
                ▼
      supervisor session (persistent context, full tools, cwd = repo root)
                │ shell / git / tmux / cli.js / restart-host.ps1
                ▼
      GUI stack ─ psmux workers ─ repos
```

The daemon stops being a keystroke-typist and becomes a **message router + watchdog**.
The TUI orch pane is simply no longer spawned (`start-workspace.ps1` gains a
no-orchestrator layout: dashboard + worker panes only).

### Components

**1. Supervisor runner (`src/supervisor.js`, new)** — generalizes `architect.js`:
- Persists `supervisorSessionId` in the CLI state dir; first turn `--session-id <uuid>`,
  later turns `--resume <sid>`. Prompt via stdin (Windows `shell:true` safe).
- Launch flags: `--append-system-prompt-file <persona>`, `--settings` (quiet statusline),
  allowlist per the permission tiers, `--permission-prompt-tool` for the approval bridge,
  `--no-chrome`, env `DISABLE_OMC=1`.
- cwd = the repo root the stack runs from, so "fix the GUI" edits the live code.
- Injectable `run()` for tests, exactly like architect.

**2. Turn queue (in daemon)** — events (user message, watchdog alert, worker hook,
schedule fire, approval callback) enqueue; one `claude -p` turn runs at a time. Events
arriving mid-turn **coalesce into the next turn's prompt** (one combined prompt, each
event labeled). Guards: max prompt size; a turn timeout (default 15 min) after which the
process is killed and the failure reported.

**3. Watchdog (in daemon)** — every tick (existing 2 s cadence, checks throttled to
~60 s): GUI host port listening; GUI daemon process alive; `GET /api/agents` on the GUI
host answers. **All-green → no turn, no tokens, no message.** A check that flips red (with
a 2-strike debounce) enqueues a watchdog event describing what failed; the supervisor
diagnoses and fixes it with its tools. A red that self-heals before the turn runs is
dropped.

**4. Approvals bridge (in daemon + tiny MCP server)** — see Permissions.

**5. Telegram UX (in daemon)** — see Telegram behavior.

## Permissions (tiered)

**Auto-allowed** (settings allowlist; no ping):
- All reads: files, logs, captures, `git status/log/diff`
- psmux control: send-keys, spawn/kill/respawn worker panes
- CLI verbs: `node src/cli.js …` (schedules, dismiss, say, status)
- Edits + commits **inside the project repos** (main repo + its worktrees)
- Restarting the GUI host / daemons (`restart-host.ps1`, `orch-gui.ps1`, `orch.ps1`)
- Running the test suites

**Telegram approval** (Allow/Deny buttons; everything not allowlisted falls through):
- `git push` — anything leaving the machine
- Deletions, `git reset --hard`, branch deletes, anything destructive
- Installing software; changes outside the project repos and orch state dirs
  (`~/.claude` settings, system config)
- Network actions other than Telegram + the Claude API

**Refuse always:** credentials, tokens, logins, payments. The supervisor never prints
secret values (masked length/pattern checks only).

**Mechanism.** The daemon ships a tiny stdio MCP server exposing one tool
(`permission_prompt`). `claude -p` is launched with `--permission-prompt-tool` pointing at
it. When the model attempts a non-allowlisted action, the tool handler:
1. sends the Telegram message with **Allow / Deny** buttons naming the exact command,
2. waits up to **2 minutes** for a tap,
3. on tap → returns allow/deny to the model mid-turn (fast path);
4. on timeout → returns **deny with reason "pending operator approval"**; the model is
   instructed (persona) to continue everything else and list the pending action in its
   reply. The daemon records the pending action; a later **Allow** tap enqueues an
   approval event ("approved: <action> — proceed") for the next turn. Deny-by-silence,
   never approve-by-timeout. One re-ping after ~2 h, then silence on that item.

## Telegram behavior

- **Ack + final:** a user message gets an instant lightweight ack (reaction or "on it"),
  then one final summary when the turn completes. Internal events (watchdog, hooks,
  schedules) get no ack.
- **Messaging contract** (baked into the persona): *silence means everything is fine;
  every message is something you asked for, something only you can decide, or something
  that broke.*
  - Message immediately: blocking decisions (approvals, ambiguity, forks); completion of
    a user request; unrecoverable failures; worker questions needing user judgment.
  - Never: idle notices, progress chatter, things it can decide itself (decide and note
    it in the summary), repeat reminders beyond the single re-ping.
  - Batching: events landing within a coalescing window go out as one message.
  - Self-directed fixes (watchdog): fix first, then one short FYI only if something
    notable was done ("GUI host was down at 06:00, restarted, healthy"). Routine no-op
    checks send nothing.
  - No quiet-hours rule (explicit user decision).
- **Commands:** plain text is a prompt turn. `/status` (daemon answers directly — cheap,
  no turn), `/reset` (rotate to a fresh supervisor session; old sid archived), `/approve`
  `/deny` as text fallbacks for the buttons.

## Session lifecycle

- **The initial session is the design conversation itself** (session id
  `00000000-0000-0000-0000-000000000000` (the session id of the design conversation) — the Claude Code session in which this spec was
  brainstormed and written). At deployment the daemon takes ownership of that id, so the
  Supervisor on Telegram is a literal continuation of that conversation, carrying its full
  project context. **Handoff rule: one driver at a time** — once the daemon owns the id,
  the original terminal/background chat must no longer be driven in parallel (two writers
  fork the timeline).
- One persistent session; context growth handled by Claude's auto-compaction. The resume
  manifest self-heals from the reported session id (same trick as the cockpit hooks) so
  compaction/rotation never strands `--resume`.
- `/reset` starts a fresh session (persona re-applied) when the user wants a clean slate —
  the escape hatch if the inherited design-conversation history ever gets in the way.
- If a `--resume` fails (missing/corrupt session), fall back to a fresh session with a
  note in the reply — never a dead channel.

## Error handling

- **Turn failure** (non-zero exit / timeout / empty stdout): retry once; then send the
  plain-text error to Telegram ("brain turn failed: …") so the channel never goes
  silently dead. The daemon itself never crashes on a failed turn.
- **Daemon down = channel down.** Mitigations: the existing hidden-singleton start
  (`orch.ps1 start`) at logon via the Startup entry, plus the watchdog being *inside* the
  daemon (no separate process to die). The GUI stack is independently supervised by its
  own startup entry; the supervisor is for its *misbehavior*, not its cold start.
- **Telegram API errors:** existing backoff (`POLL_ERROR_BACKOFF_MS`) unchanged.

## Security

- Chat-id gate (existing) on every inbound update; unknown chats ignored.
- Bot tokens stay in gitignored `.env` / `.env.gui`; never committed, never printed.
- The supervisor's persona forbids echoing secrets and forbids acting on instructions
  embedded in captured pane output / file contents (treat as data, not commands).

## Testing

Hermetic, like the rest of the repo (`test/_setup.mjs` guards):
- `supervisor.js` with injected `run()` — session-id lifecycle, stdin prompt, fresh-vs-
  resume args, failure fallback (architect tests as template).
- Turn queue — serialization, coalescing, timeout kill, retry-then-report.
- Watchdog — red/green transitions, 2-strike debounce, self-heal drop, no-turn-when-green.
- Approvals — button flow, timeout→pending, later-approve enqueue, re-ping throttle.
- No live Telegram, no real `claude`, no real psmux in tests.

## Deployment notes

- The CLI stack must run from the checkout containing this code (currently the worktree;
  master sync is standing housekeeping). `start-workspace.ps1` gets a no-orch layout;
  `orch.ps1 start` runs the evolved daemon.
- Rollback: the TUI-orch path stays in the code behind the existing config until the
  supervisor has proven itself; switching back is a daemon restart with the old mode.
