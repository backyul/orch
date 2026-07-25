#!/usr/bin/env bash
# Starts the orchestrator daemon (the SOLE Telegram poller).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$ROOT/src/cli.js" daemon
