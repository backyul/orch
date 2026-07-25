# Architect — change the cockpit GUI by chatting (Design)

**Date:** 2026-06-22
**Status:** Implemented + verified end-to-end.

## Problem

The cockpit's GUI is just files (`web/index.html`, `web/styles.css`, `web/app.js`). Agents
running *inside* PTY panes are busy with their own tasks; we want a dedicated assistant the user
can chat with to evolve the GUI itself ("rounded panes", "add a clock", "warmer accent").

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| What it is | A **headless** Claude session, one turn per message (`claude -p --resume`) | Returns clean text for a chat panel; no TUI scraping. `--resume` keeps context. |
| Scope | **`web/` only** | `cwd = web/`, persona forbids touching `vendor/` or anything outside. |
| Permissions | `--permission-mode acceptEdits --allowedTools Edit Write Read` | Headless can't show interactive prompts; tools must be explicitly enabled or it only talks. |
| Prompt delivery | via **stdin**, not `-p <msg>` | `shell:true` (needed to resolve `claude.cmd` on Windows) splits a spaced `-p` arg — stdin avoids it. |
| Safety | **Checkpoint + Revert** | Backs up the 3 editable files before each turn; one-click revert undoes the last change. |
| Apply changes | **Live reload** | Host watches `web/`; on an edit it pushes `{type:'reload'}` over `/ws-reload` and the tab refreshes. |
| Concurrency | Async spawn | A multi-second turn must not block the host event loop / other terminals. |

## Components

- `src/architect.js` — `createArchitect({root})` → `ask(message)` (async; backup → headless claude →
  reply) and `revert()` (restore the checkpoint). Session id persisted in `.omc/architect-session.json`.
- `src/pty-host.js` — `POST /api/architect {message}` → `{reply}`; `POST /api/architect/revert`;
  a debounced `fs.watch(web/)` → reload broadcast; a `/ws-reload` WebSocket.
- `web/` — Settings gains an **Architect** chat section (log + input + Send + Revert); `app.js`
  opens `/ws-reload` and reloads on signal.

## Risks (accepted, mitigated)

- **It edits the live UI** → checkpoint + Revert; a broken edit is one click to undo.
- **`acceptEdits` is broad** → scoped by `cwd = web/` + persona; localhost-only host.
- **Cost/latency** → one model call per message (seconds); fine for a design assistant.

## Verified

Real end-to-end: asked it to add a marker comment to `styles.css` → it edited the file and replied;
`revert` removed the edit and restored the backup. Unit tests cover arg construction
(`--session-id` then `--resume`), session persistence, checkpoint/restore, and error-to-reply.
