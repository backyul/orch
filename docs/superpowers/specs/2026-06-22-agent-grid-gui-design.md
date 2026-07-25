# Agent Grid GUI — Design

**Date:** 2026-06-22
**Status:** Approved design (pre-plan)
**Supersedes:** psmux/tmux as the workspace host

## Problem

The orchestrator workspace is currently hosted in **psmux** (a Windows tmux emulation). psmux
is unstable on this setup:

- After an interactive detach it renames the session to `omc-<user>-<host>-detached-<ts>`,
  which breaks `attach`/`kill`/`has-session -t omc` (the "orc-start stops working" bug).
- `.ps1` parsing is fragile to encoding (box-drawing chars require a UTF-8 BOM under
  Windows PowerShell 5.1).
- Worker routing is keyed on `omc:%N` pane targets, which go stale and misroute `send-keys`.

We want to abandon psmux/tmux entirely and replace it with a **GUI cockpit** that hosts
multiple Claude Code CLI agents as terminal panes, visible at a glance, with the orchestrator
still driving workers programmatically.

## Goals

- See multiple agents (orchestrator + workers) at a glance in one window.
- The orchestrator keeps **driving** workers programmatically (it does so today via
  `tmux send-keys`); that path is preserved, just through a new, reliable pipe.
- Stable agent hosting on Windows — no detach-rename, no stale-pane misrouting.
- Agents survive the view closing, and **resume with full context** after a host restart.
- Full mouse: app navigation, plus scrollback and text selection inside panes.
- **Import** an existing team or worker (resume its saved session/context), distinct from
  **spawning** a brand-new agent.
- Give each agent (orc + workers) an editable **persona** (a custom system prompt).
- A default orchestrator tendency: when a task is better handled by a dedicated worker, the orc
  **proposes one for the user to approve** rather than doing it itself or spawning silently.

## Non-Goals (v1)

- Multi-monitor pop-out panes.
- Themes beyond the two shipped (Dark, Claude default).
- Host-UI authentication / network exposure — v1 binds **localhost only**. (Claude and
  Telegram credentials are *configured* through Settings, but the cockpit page itself is not
  password-gated; it is only reachable on localhost.)

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| GUI role | **Full control plane** | Orchestrator drives workers today via `send-keys`; the GUI's terminal host becomes the new send/capture path so that keeps working. |
| Form factor | **Local web app** | Node host (node-pty) + browser xterm.js grid; reuses the existing Node daemon/dashboard stack; no packaging. |
| Recovery | **Auto-resume from disk** | On host restart, re-spawn each agent with `claude --resume <sessionId>`; the thing psmux never gave cleanly. |
| Agent lifecycle | **From the GUI** | `+ Add agent` / kill / restart buttons; the GUI replaces `orc-start` as the cockpit. |
| Layout | **Two modes: Auto-tile (default) ↔ Free (drag/resize)**, switchable in Settings | Tiled for "at a glance"; Free for drag-by-header + corner-resize when you want to arrange. |
| Mouse | **Scrollback + selection on; mouse-reporting forwarded** | Native xterm.js; big upgrade over psmux. |
| Settings | **In-app ⚙ modal** | Connect Claude, Telegram token, layout mode, theme — no hand-editing `.env` or scripts. |
| Claude auth | **Connect account (OAuth)** | Launches the official `claude` sign-in in the browser; no password is captured or stored by us. |
| Telegram token | **Saved to gitignored `.env`** | Masked field + chat id; written to `.env`, never committed. |
| Theme | **Claude default (warm light, default) / Dark** | Switchable live; applies to chrome and terminals. Claude theme ships as the default. |
| Import vs spawn | **Import = resume an existing saved team/member; Spawn = brand-new agent** | Import reloads context via `claude --resume`; spawn starts fresh. Distinct buttons. |
| Import source | **Saved teams + members** | A team snapshot captures each agent's name, role, orchestrator pointer, session id. Import resumes the group (or one member). |
| Team save | **Auto snapshot + manual named save** | Live `agents.json` is always importable as "(last session)"; `Save current team as…` writes named, keepable teams. Safety net against losing workers. |
| Persona | **Per-agent system prompt via `claude --append-system-prompt`** | Set at create/import, editable per pane (restart to apply); stored in the manifest + team snapshots. |
| Orc default persona | **Pre-filled + editable** | Ships with the spawn-suggestion tendency baked in; the user can edit it. |
| Orc spawn rule | **Propose → one-click Approve & spawn** | Orc has no silent spawn; it escalates a spawn request, the user approves to create the worker. |

## What is a PTY (context)

A pseudo-terminal is a software fake terminal. It has two ends: the agent side (where
`claude` attaches and is fooled into rendering its full interactive UI) and the controller
side (held by the host — writing to it is "as if typed"; reading it yields the rendered
output). This is exactly what tmux panes are: `send-keys` = write to the controller end,
`capture-pane` = read it. `node-pty` gives a Node process that same power directly, built on
Windows **ConPTY** (the official OS pseudo-terminal), which is why it is stable where psmux's
homegrown emulation is not.

## Architecture

Three units, all in the existing `telegram-orchestrator` repo.

### 1. PTY host — `src/pty-host.js`

The robust replacement for everything psmux did. A Node process that:

- Spawns each agent (`start-orchestrator.ps1` / `start-worker.ps1`, which run `claude`)
  inside a **node-pty** pseudo-terminal (ConPTY on Windows).
- Maintains a registry: `name → { pty, sessionId, status, ringbuffer }`.
  - `ringbuffer` holds recent output so reconnecting browsers and `capture` calls are not blank.
  - `status` ∈ `running | exited | resuming`.
- Persists the registry to `agents.json` on every spawn/kill (source of truth for resume).
- Exposes a **local HTTP API** (localhost only):
  - `spawn(name)` — launch the start script in a new PTY, register it.
  - `kill(name)` — terminate the PTY; keep the slot as `exited`.
  - `restart(name)` — kill + spawn (resume if a session id is known).
  - `send(name, text)` — `pty.write()` to that agent. Replaces `tmux send-keys`.
  - `capture(name, lines)` — return ringbuffer tail. Replaces `tmux capture-pane`.
  - `list()` — registry snapshot for the UI and CLI.
- Exposes **WebSockets**: each PTY's output streams to the browser; keystrokes stream back.
- Is a **singleton** — refuses to double-bind its port (same pattern as the current daemon).

### 2. Web grid — `web/` (served by the host)

The cockpit at `localhost:PORT`:

- Panes, each an **xterm.js** terminal bound to one agent's websocket.
- **Two layout modes** (switchable in Settings, remembered):
  - *Auto-tile* (default): even grid; zoom-to-maximize a pane (double-click or button).
  - *Free*: drag a pane by its header, resize from the corner; positions persisted.
- Toolbar `+ Add agent` (prompts for a name → `POST /spawn`) and a `⚙ Settings` button.
- Per-pane controls: `kill`, `restart`, `zoom`; a status badge (running / exited / resuming).
- **Theme**: Claude default (warm light, the default) or Dark; applies to chrome and terminals.
- Mouse: scroll wheel = scrollback; click-drag = select/copy; click = focus.
  Terminal mouse-reporting is left enabled so any CLI that requests clicks receives them.

### 3. Orchestrator integration

The one behavioral change to the existing system. Today the orchestrator (itself a `claude`
in a pane) drives workers with `tmux send-keys -t omc:%N` and reads them with
`tmux capture-pane`. It switches to:

- `node src/cli.js send <worker> "..."` → `POST /send` on the host.
- `node src/cli.js capture <worker>` → `GET /capture` on the host.

**Workers are addressed by name, not `omc:%N` pane targets.** `state.json` drops the
`omc:%N` pane-target mapping; the orchestrator prompt is updated to use name-addressed
commands. This eliminates the stale-pane misrouting bug class entirely.

### 4. Settings (⚙ modal + host endpoints)

An in-app modal so the user never hand-edits `.env` or scripts. Sections:

- **Claude account** — a connection-status indicator + `Connect Claude account` button that
  launches Claude Code's official OAuth sign-in (opens claude.ai in the browser). The `claude`
  CLI holds the resulting token; **we never capture or store a password**. Host endpoints:
  - `GET /settings/claude/status` — connected? (checks `claude` auth state).
  - `POST /settings/claude/connect` — kick off the official login flow.
- **Telegram bot** — masked `Bot token` + `Chat ID` fields with a `Test` button. Saved to the
  **gitignored `.env`** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`); never committed.
  - `GET /settings/telegram` — whether a token is set (value never returned in full).
  - `POST /settings/telegram` — write token + chat id to `.env`.
  - `POST /settings/telegram/test` — send a test message to verify.
- **Appearance** — Layout mode (Auto-tile ↔ Free) and Theme (Dark ↔ Claude default). These are
  client-side UI preferences, persisted in a small `ui-state` (localStorage or a JSON file);
  they don't touch agents or credentials.

**Secret handling:** the Telegram token is write-only from the UI's perspective — the host
accepts a new value and stores it in `.env`, but `GET` endpoints only report "set / not set",
never the secret. This keeps the existing security rule (token lives only in gitignored `.env`)
intact.

### 5. Teams & Import

The cockpit distinguishes **spawning** a brand-new agent from **importing** an existing one
(reloading its saved context). A worker's memory is its Claude transcript on disk
(`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`); importing resumes it via
`claude --resume <sessionId>`.

- **Team snapshot** — a named manifest capturing the group:
  ```js
  { team: 'demo-project',
    members: [ { name: 'orch', role: 'orchestrator', sessionId: '…', persona: '…orc default…' },
               { name: 'backend', role: 'worker', sessionId: '…', persona: 'Backend specialist…' } ] }
  ```
- **Auto snapshot** — the live `agents.json` (already written on every spawn/kill) doubles as
  the always-available **"(last session)"** team. You can reimport your last team even if you
  never explicitly saved it — the safety net against losing workers.
- **Named teams** — `Save current team as…` writes `teams/<name>.json`. These are keepable and
  survive across sessions.
- **Import UI** — an `Import ▾` menu (next to `+ Add agent`) lists "(last session)" + all named
  teams, each expandable to its members:
  - *Import team* → resumes **all** members (replaces the current grid — you're switching to
    that team).
  - *Import member* → resumes **one** member into the current grid (adds a pane).
- **Toolbar** also gets `Save current team as…`.

Host endpoints (a `src/teams-store.js` backs these):
- `GET /api/teams` — list "(last session)" + named teams with their members (names/roles only).
- `POST /api/teams/save` `{ team }` — snapshot the current registry to `teams/<team>.json`.
- `POST /api/teams/import` `{ team }` — resume all members of a team (replace).
- `POST /api/import-member` `{ team, name }` — resume one member into the current grid.

Import is just `spawn(name, { sessionId, resume: true })` per member — it reuses the existing
resume path; no new PTY mechanism.

### 6. Personas (per-agent system prompt)

Each agent has an optional **persona** — free text injected as `claude --append-system-prompt
"<persona>"` when the PTY launches. Because a system prompt is fixed at launch:

- Persona is set in the **Add agent** / **Import** dialog (optional), and editable later via a
  per-pane **Persona** editor (a textarea). Saving an edit **restarts that agent** to apply it
  — its transcript/memory survives the restart (`claude --resume`), only the system prompt
  changes.
- Persona is stored per agent in the manifest and team snapshots, so Import restores it.
- The PTY factory's command builder gains `--append-system-prompt <persona>` when a persona is
  set (composes with `--resume`).

**Default orchestrator persona** ships pre-filled (and editable). It encodes the standing
orchestrator role (drive workers, escalate per existing rules) **plus** this tendency:

> "If the user asks you to do something that a dedicated worker would handle better, do not do
> it yourself and do not spawn silently — propose a worker (suggest a name + why) using
> `node src/cli.js suggest-spawn <name> "<why>"`, and let the user approve it."

### 7. Orchestrator spawn suggestions (propose → approve)

The orchestrator cannot spawn agents directly; it can only **propose** one, which the user
approves. This reuses the existing pending/escalation infrastructure:

- Orc runs `node src/cli.js suggest-spawn <name> "<why>"` → writes a pending of type
  `spawn-request` to the bus (`{ ref, kind: 'spawn-request', name, why }`).
- The daemon escalates it like any pending: in the cockpit it shows an **Approve & spawn /
  Dismiss** banner; when away, it goes to Telegram with the same two buttons.
- **Approve** → the host spawns the proposed worker (`POST /api/spawn { name }`, fresh) and the
  pending clears. **Dismiss** → pending clears, nothing spawned.
- Host/daemon endpoint: `POST /api/spawn-request/approve { ref }` performs the spawn + clear.

This keeps lifecycle **user-authorized** (consistent with GUI-driven spawn) while letting the
orc drive the suggestion.

## Data Flow

- **Human types in a pane:** keystroke → websocket → host → `pty.write()` → claude.
  Output → `pty.onData` → websocket → xterm renders.
- **Orchestrator drives a worker:** orchestrator runs `node src/cli.js send worker1 "do X"`
  → host writes to worker1's PTY → output streams to worker1's pane. Mirrors send-keys,
  but reliable and name-addressed.
- **Orchestrator reads a worker:** `node src/cli.js capture worker1` → host returns
  ringbuffer tail.
- **Spawn:** click `+` → `POST /spawn {name}` → host launches the start script in a new PTY
  → new pane appears.
- **Resume after host restart:** host boots → reads `agents.json` → re-spawns each with
  `claude --resume <sessionId>` → grid repopulates with context intact.

## sessionId capture (open detail for the plan)

`--resume` needs each agent's Claude session id. Two viable mechanisms, to be settled in the
implementation plan:

1. Spawn `claude` with an explicit session id if the CLI supports setting one, so the host
   controls the mapping directly; **or**
2. After spawn, watch `~/.claude/projects/<encoded-cwd>/` for the newest `.jsonl` and record
   it as that agent's session id.

The existing orchestrator already resumes workers from their `.jsonl` transcripts, so the
mechanism exists in-repo and will be reused rather than invented.

## Recovery & Persistence

- **Browser tab closes** → agents unaffected (PTYs live in the host). Reopen → panes reattach
  and replay their ringbuffer.
- **Host restarts** (reboot/crash/manual) → read `agents.json`, re-spawn each with
  `claude --resume <sessionId>`.
- **`agents.json`** written on every spawn/kill so a mid-session crash loses nothing.

## Error Handling

- **PTY exits unexpectedly** → pane shows `exited (code N)` + `restart` button; host keeps the
  slot so the layout is preserved.
- **Resume fails** (session `.jsonl` missing/corrupt) → host spawns a fresh agent and shows a
  warning banner in that pane instead of crashing the host.
- **Browser reconnects** → host replays each pane's ringbuffer.
- **Host already running** → singleton refuses to double-bind the port.
- **`send`/`capture` to an unknown agent** → API returns a clear error so the orchestrator
  gets a real failure instead of silently misrouting.

## Testing

- **Unit:** registry logic (spawn/kill/restart/resume name→session mapping) against a fake PTY
  — no real `claude` needed.
- **Integration:** spawn a trivial PTY (a shell that echoes), `send` text, assert `capture`
  returns it; `kill`, assert status flips to `exited`.
- **Resume:** write a known `agents.json`, boot the host, assert it issues `claude --resume`
  for each entry.
- **Settings:** `POST /settings/telegram` writes token + chat id to `.env`; `GET` reports only
  "set / not set" and never echoes the secret. Claude status endpoint reflects `claude` auth
  state. (Theme/layout are client prefs — no host test needed.)
- **UI smoke:** page connects over websocket and renders a pane. Mouse/scroll/zoom, theme
  switch, and free-mode drag/resize verified manually (visual).

## v1 Scope

**In:**
- PTY host: spawn / kill / restart / send / capture / list + websockets + ringbuffers +
  `agents.json` resume; singleton; localhost-only.
- Web grid: two layout modes (auto-tile + zoom; free drag/resize with persisted positions);
  `+ Add` / kill / restart; per-pane status badge; mouse scrollback + selection.
- Settings modal: Connect Claude (OAuth), Telegram token + chat id (→ gitignored `.env`, with
  Test), layout-mode toggle, theme toggle (Claude default ships as default / Dark).
- Teams & Import: `Import ▾` menu (last-session + named teams; import whole team or one member,
  resumed), `Save current team as…`, backed by `teams-store` + the auto `agents.json` snapshot.
- Personas: per-agent system prompt via `--append-system-prompt`; set at create/import, per-pane
  editor (restart to apply), stored in manifest/teams; default orc persona pre-filled.
- Orc spawn suggestions: `suggest-spawn` CLI → `spawn-request` pending → Approve & spawn / Dismiss
  banner (cockpit + Telegram).
- Orchestrator migration: `send-keys` → `cli.js send`, `capture-pane` → `cli.js capture`;
  workers addressed by name; `state.json` + orchestrator prompt updated.
- CLI shims: `orc-start` starts the host + opens the browser; `orc-attach` opens the browser.
  Old psmux scripts (`start-workspace.ps1`, `orc-session.ps1`) retired.

**Deferred:**
- Multi-monitor pop-out panes.
- Themes beyond Dark + Claude default.
- Host-UI authentication / network exposure.

## Risks

- **Orchestrator migration is the riskiest piece** — `state.json` and the orchestrator prompt
  encode `omc:%N` targets today. Sequence the plan so the **host + grid land first**
  (independently testable), then the migration last once the host is proven.
- **sessionId capture** for `--resume` must be confirmed against the actual Claude CLI behavior
  early in the plan (see open detail above).

## Build Order (for the plan)

1. PTY host core: spawn/send/capture/kill/list + registry + ringbuffer, with a fake-PTY test
   harness.
2. WebSocket streaming + xterm.js grid (auto-tile, zoom, mouse).
3. Lifecycle UI: `+ Add` / kill / restart + status badges.
4. `agents.json` persistence + auto-resume on boot.
5. Settings modal + host endpoints: Connect Claude (OAuth), Telegram token → `.env` (+ Test),
   theme + layout-mode toggles (free drag/resize, persisted positions).
6. Teams & Import: `teams-store`, `Import ▾` (last-session + named teams, import team/member),
   `Save current team as…`.
7. Personas: `--append-system-prompt` in the command builder; persona in spawn/manifest/teams;
   per-pane Persona editor (restart to apply); default orc persona.
8. Orc spawn suggestions: `suggest-spawn` CLI + `spawn-request` pending + Approve/Dismiss
   (cockpit banner + Telegram buttons + approve→spawn).
9. Orchestrator migration off `send-keys`/`capture-pane` to name-addressed `cli.js`.
10. CLI shims + retire psmux scripts.
