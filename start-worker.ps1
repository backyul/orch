#!/usr/bin/env pwsh
# Usage (run INSIDE a tmux/psmux pane): ./start-worker.ps1 <worker-name>
# Registers this pane (session-qualified) with the orchestrator, then launches a
# claude worker with the orchestrator hooks installed. Use this on Windows, where
# tmux panes run PowerShell and `bash` resolves to WSL.
param([Parameter(Mandatory = $true)][string]$Name)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition

# psmux pane ids are per-session (every session has its own %1), so register the
# SESSION-QUALIFIED target — a bare pane id is ambiguous across sessions.
# Resolve THIS pane. psmux's `display-message` can't identify the calling pane for #{pane_id}
# (it returns the session's ACTIVE pane — so every worker would register the same id). Use
# $TMUX_PANE (set uniquely per pane) for the pane id; display-message only for the session name.
if (-not $env:TMUX_PANE) { Write-Error 'Must run inside a tmux/psmux pane.'; exit 1 }
$session = (tmux display-message -p '#{session_name}').Trim()
$Target = "${session}:$env:TMUX_PANE"

node "$Root/src/cli.js" register-worker $Name $Target
$env:ORCH_WORKER = $Name

# `claude` is often not on a tmux pane's PATH; invoke the npm launcher directly.
$Claude = Join-Path $env:APPDATA 'npm\claude.cmd'
if (-not (Test-Path $Claude)) { $Claude = 'claude' }
& $Claude --settings "$Root/config/worker.settings.json"
