# send-keys Fidelity Findings (Task 11 spike)

Empirical results from driving a real `claude` worker (Claude Code v2.1.176) in a
psmux/tmux pane on Windows, 2026-06-15/16. These determine how `deliverReply` must
encode answers for each prompt type.

## Environment notes (surprises worth knowing)

- **tmux panes run PowerShell here**, and `bash` inside a pane resolves to WSL (no distro
  installed) — so `start-worker.sh` cannot be run *inside* a pane. Launch the worker
  directly: set `$env:ORCH_WORKER`, then run claude. `claude` was not on the pane's PATH;
  it had to be invoked via its full launcher path (`...\AppData\Roaming\npm\claude.cmd`).
- **psmux pane-ids are NOT globally unique.** Each session starts numbering at `%1`, so
  `scratch:%1` and `w1real:%1` coexisted. Bare `%1` is therefore ambiguous across sessions.
  → Workers must be registered with a **session-qualified target** (e.g. `w1real:%1`), not a
  bare pane id. `register-worker <name> <session:%pane>` works for this.

## Prompt-type fidelity

### AskUserQuestion (multiple choice) — THE key finding
The picker renders as a numbered list with arrow navigation:
```
❯ 1. Tabs
  2. Spaces
  3. Type something.
Enter to select · ↑/↓ to navigate · Esc to cancel
```
- **Sending the option NUMBER selects it immediately — no Enter needed.** Sending `2`
  instantly chose "Spaces" (pane showed `Tabs or spaces? → Spaces`).
- Sending the option **label text** (`Tabs`) does NOT select — there is no text-filter on
  the default options; typed text would fall through toward the "Type something" path.
- **Implementation:** for `type: "options"`, `deliverReply` sends `String(index+1)` with
  `{ enter: false }` (index comes from the inline-button `callback_data` `<ref>::<idx>`).
  Verified live: a Telegram button tap selects the matching option in the worker.

### Free-text prompts
- Typed text followed by Enter submits correctly. `deliverReply` sends the answer text with
  the default trailing Enter. (Verified via the scratch-pane harness; standard TUI behavior.)
- Note: Telegram applies autocapitalize/autocorrect, so free-text answers arrive verbatim
  including those transforms (e.g. `config.js` → `Config.js`). Not a bug; inform the worker
  prompt accordingly if case matters.

### Permission prompts
- A permission request fires the `Notification` hook (a `freetext`-type pending,
  text "Claude needs your permission"). The selector is a Yes/No list similar to
  AskUserQuestion. **Not yet exhaustively tested**; likely needs the same number-key
  approach (`1`=allow). TODO: confirm and special-case if needed.

## Known gap surfaced by the spike

- **No `PostToolUse[AskUserQuestion]` hook.** When a question is answered *in the pane*
  (at the terminal), the `pending/<ref>.json` file is NOT removed (the only AskUserQuestion
  hook is `PreToolUse`, which fires when *asked*, not when *answered*). So the tick
  terminal-resolution reconciliation won't auto-fire for AskUserQuestion answered in-pane,
  and a lingering Telegram escalation could be tapped later and double-deliver.
  **Recommended fix:** add a `PostToolUse` matcher for `AskUserQuestion` that removes the
  matching pending by worker, so in-pane answers clear the escalation.
