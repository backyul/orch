#!/usr/bin/env pwsh
# Run INSIDE a tmux/psmux pane: ./start-orchestrator.ps1 [name]
# Launches the orchestrator agent (a claude session) with the worker hooks + role note,
# registers its pane (session-qualified), and marks it as the orchestrator.
param([string]$Name = 'orch')

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
# Resolve THIS pane. psmux's `display-message` can't identify the calling pane for #{pane_id}
# (it returns the session's ACTIVE pane), so use $TMUX_PANE (set uniquely per pane) for the
# pane id; display-message only for the session name.
if (-not $env:TMUX_PANE) { Write-Error 'Must run inside a tmux/psmux pane.'; exit 1 }
$session = (tmux display-message -p '#{session_name}').Trim()
$Target = "${session}:$env:TMUX_PANE"

node "$Root/src/cli.js" register-worker $Name $Target
node "$Root/src/cli.js" set-orchestrator $Name
$env:ORCH_WORKER = $Name

# Generate the orchestrator settings (worker hooks + a permission allowlist) with absolute
# hook paths. The allowlist auto-runs safe tools (cli.js, tmux, read-only git, tests, reads);
# anything risky/unlisted prompts, and that prompt escalates to the operator's phone.
$RootFwd = $Root -replace '\\', '/'
$Settings = (Get-Content -Raw "$Root/config/orchestrator.settings.example.json") -replace 'ABSOLUTE_PATH', $RootFwd
$SettingsPath = "$Root/config/orchestrator.settings.json"
Set-Content -Path $SettingsPath -Value $Settings -NoNewline

# Pass a SHORT bootstrap prompt (not the whole role note) — multi-line text with quotes
# gets mangled as a cmd-line arg. The agent reads the full role from the file itself.
$Boot = 'You are the orchestrator agent. Read the file config/ORCH_ROLE.md in full right now (use the Read tool) and follow it exactly — it explains how you communicate and ends by telling you to announce yourself. Do that now.'
$Claude = Join-Path $env:APPDATA 'npm\claude.cmd'
if (-not (Test-Path $Claude)) { $Claude = 'claude' }
& $Claude --settings $SettingsPath $Boot
