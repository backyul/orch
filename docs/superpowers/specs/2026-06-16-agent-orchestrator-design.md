# Agent Orchestrator — Design Spec

**Date:** 2026-06-16 (rev 2 — triage routing) · **Status:** Proposed (awaiting approval)
**Builds on:** the live transport/daemon layer.

## Problem / correction

The original request was for an **agent orchestrator** — "an agent in claude code cli that
orchestrates the other claude code cli sessions… when the orchestrator needs confirmation from
me… I can ask the orchestrator any time about what agents are doing." The first build delivered
the transport/escalation plumbing (a dumb daemon) but reduced the orchestrator to an on-demand
headless summary call. This spec adds the missing piece: a **persistent Claude orchestrator
agent** that you converse with, that **drives** the workers, and that **triages worker prompts**
so you're only asked about what truly needs you. The daemon is demoted to the **bridge**.

## Goal (v1)

- A persistent `claude` orchestrator **agent** runs in its own pane.
- You message it on Telegram; it **both** answers/relays **and** drives workers (per message).
- **Worker prompts are triaged by the orchestrator** (chosen routing = "B"): a worker's
  question/permission goes to the orchestrator, which answers it itself per your standing rules,
  and escalates to **you** only what it can't/shouldn't decide.
- When the orchestrator escalates to you (or needs its own confirmation), it asks via Telegram
  with buttons, reusing the existing escalation path.

## Non-goals (v1)

- No fallback to direct worker→you escalation if the orchestrator is down (that was option "C";
  user chose "B"). If the orchestrator isn't running, worker prompts wait — see Error handling.
- No autonomous background activity without a trigger (turn-based).
- One bot, one poller (the daemon). Not the official plugin.

## Architecture

```
  You (Telegram)
        │  (sole poller)
        ▼
   ┌──────────────┐  your msg: inbox file + short nudge ─┐
   │    DAEMON     │  worker prompt: nudge "w1 needs X"   ├─► ┌────────────────────────┐
   │  (bridge +    │ ────────────────────────────────────┘   │  ORCHESTRATOR AGENT     │
   │   notifier)   │ ◄─── orch's reply: `cli.js say "…"`      │  (claude, own pane)     │
   │              ◄│ ◄─── orch's AskUserQuestion → buttons    │                         │
   └──────────────┘                                           └─────────┬──────────────┘
                                                  answers workers via    │
                                              `cli.js answer <ref> ...`   ▼  (or drives tasks)
                                                          ┌────────────────────────────┐
                                                          │  w1, w2, … (claude workers) │
                                                          └────────────────────────────┘
```

**The daemon escalates to YOUR phone ONLY the orchestrator's own prompts.** Worker prompts never
go straight to you — they're handed to the orchestrator. Distinguished by worker name:
`state.orchestratorWorker` identifies the orchestrator's pane; a pending from *that* worker →
escalate to Telegram (buttons); a pending from any *other* worker → deliver to the orchestrator.

### Inbound classification (daemon, per Telegram update)
1. Button tap / reply to a known escalation → it's **your answer to the orchestrator's question**
   → route the number/text into the orchestrator pane (existing send-keys path).
2. `/away` `/back` `/status` → commands.
3. Anything else (plain text) → **deliver to the orchestrator agent** (inbox + nudge).

### Worker-prompt delivery (daemon → orchestrator)
When a non-orchestrator worker has a pending (and you're away, or it's sat past the idle
timeout), the daemon nudges the orchestrator with a structured note:
> `Worker w1 needs input — "<question>" options:[Yes,No]. Handle it: answer with`
> `node src/cli.js answer <ref> "<choice>"  — or ask me via AskUserQuestion if it needs my call.`
The orchestrator then either resolves it (`cli.js answer`) or escalates to you.

### New CLI verbs the orchestrator uses (clean, robust — no pane scraping)
- `cli.js answer <ref> <choiceTextOrIndex>` — resolve a worker pending (reuses the routing core:
  digit-select for options, text+Enter for free-text, routes to the registered session-qualified
  pane, clears the pending, records the reply). How the orchestrator answers workers.
- `cli.js inbox` — print and clear all queued inbound messages (your Telegram texts + worker-prompt
  triage notes). The orchestrator runs this when nudged.
- `cli.js say "<message>"` — send a message to your Telegram (direct `sendMessage` POST; does not
  conflict with the daemon's getUpdates poller). How the orchestrator talks to you. Replaces the
  Stop-hook/outbox idea entirely — the agent explicitly reads (`inbox`) and speaks (`say`).

### Inbound bridge (hardened — file + nudge)
Your message (or a worker-prompt triage note) → `orch-inbox/<seq>.txt`; daemon `send-keys` a short
fixed nudge into the orchestrator pane — a one-line Claude turn:
`📥 New orchestrator message(s) — run \`node src/cli.js inbox\` to read, then act per your role.`
Clean text comes from `cli.js inbox`, not from keystrokes. No Stop hook, no outbox.

### Standing triage rules (approved 2026-06-16)
The orchestrator's role note embeds these; you can change them anytime via Telegram.

**Auto-handle (don't escalate):** read-only/inspection (reading files, searches,
`git status/diff/log`, capture-pane, listing); tests/builds/linters/formatters/typecheck; edits
to source & test files inside the project worktree; installing known dev deps (`npm install`).

**Always ask the user:** destructive ops (`rm -rf`, deleting things not created this session,
dropping DB tables, `git reset --hard`, force-push, history rewrite); production/deploy
(prod-touching, deploys, releases, migrations on real data); anything that spends money; external
comms (email/messages, public posts, PRs/issues on external repos); secrets (real tokens/keys,
auth changes); anything not clearly covered or high-stakes.

**Free-text worker questions:** low-stakes design choices → decide per project conventions;
anything committing to a costly/risky direction → ask the user.

### State / bus additions
`orch-inbox/` dir; `state.orchestratorWorker` (the orchestrator pane's name).

### Launch
`start-orchestrator.ps1`: starts the agent reusing `config/worker.settings.json` (the same
Notification / AskUserQuestion / PostToolUse hooks — so the orchestrator's OWN questions and
permissions escalate to you), registers its pane (session-qualified), sets
`state.orchestratorWorker`, and passes `config/ORCH_ROLE.md` as the opening prompt (how to read
nudges via `cli.js inbox`, answer workers via `cli.js answer`, talk to you via `cli.js say`,
the standing rules, and when to ask you). No separate settings file or Stop hook needed.

## Core flows

**A. You ask the orchestrator something** — You → TG → daemon inbox+nudge → agent reads, drives
workers / reasons → Stop hook → outbox → daemon → TG reply.

**B. Worker needs input (triage)** — worker hook → pending → daemon nudges orchestrator → it
either `cli.js answer <ref> …` (routine, per rules) or escalates to you via AskUserQuestion →
daemon buttons → you tap → routed into orch pane → orch applies the answer to the worker.

**C. Orchestrator needs your confirmation** — orchestrator `AskUserQuestion` → its hook → pending
(from `orchestratorWorker`) → daemon escalates to you with buttons → tap → routed back.

## Error handling
- **Orchestrator not running** and a worker prompt arrives → the daemon, after a short grace,
  sends you a one-time note: "Orchestrator is down; w1 is waiting — start it with
  `./start-orchestrator.ps1` or answer at the terminal." (No silent stranding even in "B".)
- Stop hook can't parse a reply → send "(orchestrator finished; no message)" not silence.
- Nudge while orch pane is mid-prompt → inbox queued; processed after it resolves.

## Success criteria (v1)
- Orchestrator agent runs in a pane; status shows it registered as `orchestratorWorker`.
- "What are the workers doing?" → the **agent** reads worker panes and replies; follow-up keeps context.
- "Have w1 do X" → it dispatches into w1's pane and confirms.
- A worker hits a routine prompt → the orchestrator auto-answers it (per rules); you aren't pinged.
- A worker hits a prompt the rules don't cover → the orchestrator asks **you** (buttons) → your
  tap flows back through the orchestrator to the worker.
- Still one bot, one poller.
