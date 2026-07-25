#!/usr/bin/env bash
# Usage: start-worker.sh <worker-name>
# Launches a claude worker in the CURRENT tmux pane with hooks installed,
# then registers this pane with the orchestrator under <worker-name>.
set -euo pipefail
NAME="${1:?usage: start-worker.sh <worker-name>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# psmux pane ids are per-session (every session has its own %1), so register the
# SESSION-QUALIFIED target — a bare $TMUX_PANE is ambiguous across sessions.
TARGET="$(tmux display-message -p '#{session_name}:#{pane_id}')"
[ -n "$TARGET" ] || { echo "must run inside a tmux/psmux pane" >&2; exit 1; }
node "$ROOT/src/cli.js" register-worker "$NAME" "$TARGET"

export ORCH_WORKER="$NAME"
exec claude --settings "$ROOT/config/worker.settings.json"
