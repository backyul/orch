# Readable Telegram Messages — Design Spec

**Date:** 2026-06-19 · **Status:** Approved

## Problem
The orchestrator's Telegram messages are hard to read on a phone: long run-on paragraphs,
em-dash chains, internal details (file paths, commit hashes, code snippets — e.g. a
`[ScriptBlock]::Create(...)` snippet inside a permission confirmation), and no structure. Two
sources: (a) the orchestrator agent's own `cli.js say` messages (it has no style guidance, so it
writes verbose prose), and (b) daemon-generated messages (the button-collapse shows an ugly ref
tag + the full, sometimes very long, option text).

## Decisions (from brainstorming)
- **Default style = structured summary:** a one-line outcome headline, then ≤4 short `•` bullets
  if needed. No code/paths/commit-hashes/jargon unless the operator asks. No walls of text.
- **Plain text only** — no Telegram Markdown (avoids special-char escaping fragility).
- **Clean up daemon messages too** — drop ref tags, shorten over-long option text.

## Changes

### 1. `config/ORCH_ROLE.md` — add "How to write to the operator"
A section instructing the agent:
- Lead with the outcome in one line (headline); then at most ~4 short `•` bullets, else stop.
- Plain, phone-first language. No code, file paths, commit hashes, or internal jargon unless the
  operator explicitly asks.
- Never a long run-on paragraph or em-dash chains. One message per update (don't fragment).
- Plain text (no markdown).
- Note: only **new** orchestrator sessions pick this up (role note is read at launch).

### 2. `src/daemon.js` — tidy daemon-generated messages
- Add `shorten(text, max = 60)` helper: returns `text` if ≤ max, else first `max` chars + `…`.
- **Button-collapse:** `✅ ${ref} — you chose: ${answer}` → `✅ You chose: ${shorten(answer)}`.
- **Answered-at-terminal note:** `✅ ${ref} was answered at the terminal — ignore that earlier
  request.` → `✅ Answered at the terminal — ignore the earlier request.` (drop ref).
- **Orchestrator-down note:** keep (already worker-named, no ref); tighten wording only if trivial.
- Escalation question already uses `⚠️ ${worker} needs you:` — unchanged.

### 3. Tests
- `shorten()`: under-limit unchanged; over-limit truncated to `max` + `…`.
- Button-collapse test now asserts `/You chose:/` and NOT the ref.
- Answered-at-terminal reconciliation test asserts no ref in the message.
- Update existing daemon assertions that referenced the old `you chose: ${ref}` text.

## Scope guard (YAGNI)
No markdown, no per-message-type templates, no message threading/history. Just the style rules +
the daemon cleanup.

## Success criteria
- A representative orchestrator update reads as a headline + a few bullets, no code/paths.
- The tap-confirmation reads `✅ You chose: <short option>` with no ref and no giant snippet.
- All unit tests green.
