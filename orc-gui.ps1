#!/usr/bin/env pwsh
# Start the PTY-host cockpit (singleton) + its OWN isolated Telegram daemon, then open the browser.
# This replaces the old psmux workspace (start-workspace.ps1 / orc-session.ps1).
#
# The cockpit runs as an ISOLATED orchestrator instance: its own bot (.env.gui) and its own state
# dir (~/.claude/orchestrator-gui), separate from the terminal orchestrator (./orch.ps1, which uses
# the default .env bot and ~/.claude/orchestrator state). Two bots => no Telegram getUpdates clash.
param([int]$Port = 7610, [switch]$NoBrowser)
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$env:HOST_PORT      = "$Port"
$env:ORCH_STATE_DIR = Join-Path $env:USERPROFILE '.claude\orchestrator-gui'
$env:ORCH_ENV_FILE  = Join-Path $Root '.env.gui'
$env:ORCH_DRIVER    = 'host'   # GUI delivers via the PTY host (agents by name), never psmux

# The cockpit's GUI daemon (its sole Telegram poller for the GUI bot). Separate from ./orch.ps1.
& "$Root/orch-gui.ps1" start | Out-Null

# Start the host detached if nothing is listening on the port yet. Pass the isolation env through so
# the host (and the agents it spawns) read/write the GUI state dir + GUI bot token.
$listening = $false
try { $listening = (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) } catch { $listening = $false }
if (-not $listening) {
  Start-Process pwsh -ArgumentList '-NoLogo', '-Command', "cd `"$Root`"; `$env:HOST_PORT='$Port'; `$env:ORCH_STATE_DIR='$($env:ORCH_STATE_DIR)'; `$env:ORCH_ENV_FILE='$($env:ORCH_ENV_FILE)'; node src/pty-host.js" -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

# -NoBrowser: silent start (used by the logon Startup entry) — backend up, browser only when you want it.
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }
Write-Host "Cockpit: http://127.0.0.1:$Port/  (GUI bot + isolated state. Add agents in the UI; Ctrl-click the URL if it didn't open.)"
