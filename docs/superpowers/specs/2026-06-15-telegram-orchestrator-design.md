# Telegram Orchestrator — Design Spec

**Date:** 2026-06-15
**Status:** Approved design (pending implementation plan)
**Project dir:** `~/telegram-orchestrator`

## Problem

When running multiple interactive Claude Code CLI sessions in tmux/psmux panes, the
user must be physically at the terminal to answer the questions those sessions raise
(permission prompts, multiple-choice questions, free-text "which approach?" pauses). When
the user steps away, work stalls silently. The user wants to be reached on Telegram when —
and only when — they are away, to answer those questions from their phone, and to be able
to ask, in natural language, what the agents are doing and get a summary back.

This system has been built here before and ran end-to-end once; it was torn down on
2026-06-15 for a clean rebuild. This spec captures the clean architecture plus the
hard-won lessons from the prior attempt.

## Goals (v1)

- **Full loop, multiple workers.** Prove the entire pipeline with several concurrent worker
  sessions, with correct reply-to-worker routing from day one.
- A worker raising a question → escalation to Telegram **only when the user is away** →
  user answers on Telegram (options *or* free text) → answer routed back into the correct
  worker pane, which then continues.
- User can message the orchestrator on Telegram in natural language ("what's everyone
  doing?", follow-ups) and get summaries.

## Non-goals (v1)

- No web UI, no mobile app beyond Telegram.
- No multi-user support — single operator, allowlisted by Telegram chat ID.
- No persistence/analytics beyond the working file bus.
- Not changing how workers are launched beyond installing hook scripts + settings.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Away detection | **Hybrid** | Auto idle-timeout by default; `/away` forces immediate escalation; `/back` suppresses. Robust without requiring the user to always remember a toggle. |
| Idle timeout | **90s** | Long enough to avoid pinging while the user is thinking at the terminal; short enough to stay responsive. |
| Question detection | **Hooks + pane-capture fallback** | Hooks (`Notification`, `PreToolUse[AskUserQuestion]`) give precise, structured, instant detection for permission/structured cases; pane-capture polling catches free-text waits hooks are blind to. |
| Orchestrator structure | **LLM session + daemon (split)** | Always-on timers/polling cannot live in an LLM (a Claude session only acts when prompted). A persistent orchestrator session keeps conversational context for exploratory "what's happening?" follow-ups, which stateless one-shot API calls would lose. |
| Transport | **File bus** under `~/.claude/orchestrator/` | Zero-dep, debuggable (`cat` pending questions), survives restarts, clean seam between daemon (plumbing) and orchestrator session (language). |
| Reply addressing | **Inline buttons** (options) + **reply-threading** (free text) | No command-style `/reply` needed. Each pending Q carries a short **ref tag** mapping to a pane. |
| Bot | **Single fresh bot**, single poller | Telegram `getUpdates` is single-consumer per bot. |
| Runtime | **Zero-dep ESM Node**, Windows, psmux | Matches environment; carries the watcher main-guard fix. |

## Architecture

```
                  ┌─────────────────────────────────────┐
   Telegram  ◄───►│  Orchestrator (claude session)      │  natural-language chat,
   (phone)        │  + Telegram channel (SOLE poller)   │  summaries, free-text reply
                  └───────────────┬─────────────────────┘  interpretation
                                  │ reads/writes
                          ┌───────▼────────┐
                          │   File bus      │  ~/.claude/orchestrator/
                          │  pending Qs,    │
                          │  replies,       │
                          │  away-state     │
                          └───▲────────┬────┘
              hook scripts    │        │   send-keys
              write here      │        │   reply routing
                  ┌───────────┴──┐  ┌──▼──────────────┐
                  │  Daemon       │  │  Worker panes    │  each = a claude session
                  │ (zero-dep     │  │  W1  W2  W3 …    │  in tmux/psmux, with hooks
                  │  Node)        │  └─────────────────┘
                  │ timers, poll, │
                  │ escalation,   │
                  │ send-keys     │
                  └────────────────┘
```

### Components & responsibilities

| Component | Owns | Does NOT do |
|---|---|---|
| **Hook scripts** (each worker's `settings.json`) | On `Notification` / `PreToolUse[AskUserQuestion]`, write a pending-question record to the bus | No Telegram, no timers |
| **Daemon** (Node, always-on) | Idle timers per pending Q; pane-capture polling (free-text fallback); hybrid away logic; on reply record → `send-keys` into correct pane; maintain away-state | No LLM, no natural-language work |
| **Orchestrator session** (claude + Telegram channel) | Receives Telegram messages; answers "what's happening?" via bus + `capture-pane`; interprets/forwards free-text answers; pushes escalation messages | No timers; no direct key-injection (requests daemon via bus) |
| **Telegram bot** (single fresh token) | Transport only | — |

### Data model (file bus)

Under `~/.claude/orchestrator/`:

- `pending/<ref>.json` — `{ ref, worker, paneId, type: "options"|"freetext", text, options?: string[], createdAt, escalatedAt? }`
- `replies/<ref>.json` — `{ ref, answer, source: "telegram"|"terminal", answeredAt }`
- `state.json` — `{ away: bool, awaySetAt, allowedChatId, workers: { name: { paneId, lastSeen } } }`

The **ref tag** (e.g. `W2·a3f`) is the routing key: unique per pending question, maps to a
pane. Simultaneous questions from different workers never cross wires because each carries
its own ref.

## Core flows

### A. Worker needs input → user (away)
1. Worker raises a question → hook writes `pending/<ref>.json`.
2. Daemon starts a 90s idle timer for that ref. If `state.away` → escalate immediately;
   else wait for timeout. Pane-capture polling independently catches free-text waits that
   never produced a hook.
3. On escalation, a Telegram message is sent: *"⚠️ W2·a3f needs you: `<question>`"* —
   **inline buttons** for `options` type, plain prompt for `freetext`.

### B. User answers on Telegram → worker
4. User taps a button or replies (optionally reply-threaded to the ref).
5. Orchestrator/daemon resolves `ref → paneId`, writes `replies/<ref>.json`.
6. Daemon `send-keys` the answer + Enter into that pane. Worker continues. `pending/<ref>`
   is cleared.

### C. User asks "what's everyone doing?"
7. Orchestrator reads bus state + runs `capture-pane` on each worker pane, summarizes in
   natural language, replies. Follow-up questions stay in session context.

## Error handling

- **Reply to an already-answered/expired ref:** daemon detects no matching `pending/<ref>`,
  informs the user via the orchestrator ("that question was already handled at the terminal").
- **User answers at terminal while escalation is out:** hook/pane state clears `pending/<ref>`;
  daemon cancels the timer and (if already escalated) sends a Telegram note that it's resolved.
- **Pane gone / worker exited:** `send-keys` target missing → daemon reports failure to route.
- **Duplicate pollers:** prevented structurally (plugin disabled globally, enabled only for the
  orchestrator session via `--settings`). A startup check refuses to run a second poller.
- **Unauthorized Telegram sender:** messages from any chat id other than `allowedChatId` are ignored.

## Constraints baked in (prior-attempt lessons)

- **Exactly one Telegram poller.** Plugin globally disabled; enabled for the orchestrator
  session only via per-session `--settings` (enabledPlugins merge). Single bot, single consumer.
- `--channels plugin:telegram@...` does **not** start the poller unless the plugin is enabled.
- `--channels` is variadic — any prompt must come **before** it or it is swallowed.
- **Allowlist** only the operator's Telegram chat id.
- **Windows/ESM**: zero-dep ESM Node with the main-guard fix; `tmux` here is psmux.
- **Fresh bot token** from @BotFather is required before live testing (old bots deleted).
  This is the one external prerequisite only the user can provide.

## Open external prerequisite

- A new Telegram bot + token from @BotFather, and the operator's Telegram chat id.
  Needed for live end-to-end testing, not for building/structuring the code.

## Success criteria (v1 done)

- Two+ worker sessions running in panes; each can raise a question.
- With `/away` set, a worker question reaches Telegram within seconds, with correct
  buttons/free-text prompt and a ref tag.
- Answering on Telegram (button or reply) lands in the *correct* worker pane and it proceeds.
- Without away, a question answered at the terminal within 90s never escalates.
- "What's everyone doing?" returns an accurate natural-language summary.
- Only one Telegram poller ever runs; only the allowlisted chat id is honored.
