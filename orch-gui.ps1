#!/usr/bin/env pwsh
# Manager for the cockpit GUI's OWN orchestrator daemon: a second, isolated Telegram poller bound
# to the GUI bot (.env.gui) with its own state dir (~/.claude/orchestrator-gui). This is separate
# from ./orch.ps1, which manages the terminal orchestrator daemon (the default bot + default state).
# The two never collide: different bot tokens (no getUpdates conflict) and different state dirs.
#
#   ./orch-gui.ps1 start     kill any existing GUI daemon, then start one (hidden, logged)
#   ./orch-gui.ps1 stop      stop the GUI daemon
#   ./orch-gui.ps1 restart   stop + start (use after changing the GUI bot token or pulling code)
#   ./orch-gui.ps1 status    is it running? + state dir (default)
#   ./orch-gui.ps1 logs      show the last lines of the GUI daemon log
param([Parameter(Position = 0)][ValidateSet('start', 'stop', 'restart', 'status', 'logs')][string]$Action = 'status')

$Root     = Split-Path -Parent $MyInvocation.MyCommand.Definition
$StateDir = Join-Path $env:USERPROFILE '.claude\orchestrator-gui'
$EnvFile  = Join-Path $Root '.env.gui'
$Log      = Join-Path $StateDir 'daemon-gui.log'

# Distinguished from the terminal daemon by the trailing 'gui' marker arg in the command line.
function Get-GuiDaemons {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*cli.js daemon gui*' }
}

function Stop-GuiDaemon {
  $procs = Get-GuiDaemons
  if ($procs) {
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Host "stopped GUI daemon (PID $($procs.ProcessId -join ','))"
  } else {
    Write-Host "no GUI daemon was running"
  }
}

function Start-GuiDaemon {
  if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
  if (-not (Test-Path $EnvFile)) {
    Write-Host "WARNING: $EnvFile not found - set the GUI bot token in the cockpit Settings (it saves here)."
  }
  $env:ORCH_STATE_DIR = $StateDir   # isolated state: pending/replies/workers/away
  $env:ORCH_ENV_FILE  = $EnvFile    # isolated bot token: the GUI bot
  $env:ORCH_DRIVER    = 'host'      # the GUI daemon drives the PTY host (agents by name), not psmux
  Start-Process -FilePath 'node' -ArgumentList 'src/cli.js', 'daemon', 'gui' `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" | Out-Null
  Start-Sleep -Milliseconds 1200
  $d = Get-GuiDaemons
  if ($d) {
    Write-Host "GUI daemon started (PID $($d.ProcessId -join ',')) - polls the GUI bot. logs: ./orch-gui.ps1 logs"
  } else {
    Write-Host "FAILED to start; recent log:"
    if (Test-Path "$Log.err") { Get-Content "$Log.err" -Tail 5 }
    if (Test-Path $Log) { Get-Content $Log -Tail 5 }
  }
}

switch ($Action) {
  'start'   { Stop-GuiDaemon; Start-GuiDaemon }
  'stop'    { Stop-GuiDaemon }
  'restart' { Stop-GuiDaemon; Start-GuiDaemon }
  'logs'    { if (Test-Path $Log) { Get-Content $Log -Tail 20 } else { Write-Host "no log yet" } }
  'status'  {
    $d = Get-GuiDaemons
    if ($d) { Write-Host "GUI daemon: RUNNING (PID $($d.ProcessId -join ','))" }
    else    { Write-Host "GUI daemon: stopped" }
    Write-Host "state dir: $StateDir"
    Write-Host "env file:  $EnvFile"
  }
}
