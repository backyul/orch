# Claude CLI session-id / resume — spike findings (Task 6)

Date: 2026-06-22. Resolved against the installed `claude` CLI (`claude --help`).

## Relevant flags (confirmed present)

- `--session-id <uuid>` — **Use a specific session ID for the session.** Lets us *set* the id
  at launch.
- `-r, --resume [value]` — resume a conversation by session ID.
- `-c, --continue` — continue the most recent conversation.
- `--fork-session` — when resuming, create a new session id (NOT what we want; we want the same
  id to persist).
- `--append-system-prompt <prompt>` — append to the system prompt (used for personas).
- `-n, --name <name>` — display name shown in the prompt box.

## Decision: Mechanism A (host sets the session id)

We do **not** need to watch `~/.claude/projects/<cwd>/` for the newest `.jsonl`. Instead:

- **Fresh spawn:** the host generates a UUID (`crypto.randomUUID()`), launches
  `claude --session-id <uuid> [--append-system-prompt <persona>] [-n <name>]`, and records
  `<uuid>` as the agent's `sessionId` immediately. The manifest therefore always has a real,
  resumable id from the moment of spawn.
- **Resume (import / host restart):** launch `claude --resume <sessionId>
  [--append-system-prompt <persona>]`.

Transcripts for this repo land in `~/.claude/projects/C--path-to-telegram-orchestrator/<sessionId>.jsonl`
(the project dir encodes the launch cwd). The host launches agents with cwd = repo root so the
encoding is stable.

## Impact on the plan

- **Task 7 (`buildClaudeCommand`)**: takes `{ resume, sessionId, persona, name }` and emits:
  - resume → `--resume <sessionId>`
  - fresh  → `--session-id <sessionId>` (the UUID the registry generated)
  - always → `--append-system-prompt <persona>` when persona set; `-n <name>` for the display name.
- **Registry `spawn`**: when not resuming and no `sessionId` was supplied, generate one
  (`crypto.randomUUID()`) and store it so the manifest is immediately resumable.
- **Task 22 / settings claudeStatus**: `claude --version` exit 0 is a coarse "installed" check;
  there is no obvious non-interactive "am I logged in" subcommand in `--help`, so the Connect
  flow remains "launch `claude` interactively and let it prompt sign-in". Revisit if a dedicated
  auth-status command surfaces.
