#!/usr/bin/env pwsh
# Single-command orchestrator-daemon manager. Guarantees EXACTLY ONE daemon, so
# the "Conflict: another getUpdates" problem can't happen.
#
#   ./orch.ps1 start     kill any existing daemon, then start one (hidden, logged)
#   ./orch.ps1 stop      stop the daemon
#   ./orch.ps1 restart   stop + start (use after pulling code changes)
#   ./orch.ps1 status    is it running? + bus state (default)
#   ./orch.ps1 logs      show the last lines of the daemon log
param([Parameter(Position = 0)][ValidateSet('start', 'stop', 'restart', 'status', 'logs')][string]$Action = 'status')

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Log  = Join-Path $env:USERPROFILE '.claude\orchestrator\daemon.log'

function Get-Daemons {
  # Match the terminal daemon only — exclude the cockpit GUI daemon (./orch-gui.ps1), which carries
  # a trailing 'gui' marker, so the two managers never stop each other.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*cli.js daemon*' -and $_.CommandLine -notlike '*cli.js daemon gui*' }
}

function Stop-Daemon {
  $procs = Get-Daemons
  if ($procs) {
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Host "stopped daemon (PID $($procs.ProcessId -join ','))"
  } else {
    Write-Host "no daemon was running"
  }
}

function Start-Daemon {
  $dir = Split-Path -Parent $Log
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $env:ORCH_DRIVER = 'psmux'   # the terminal daemon drives psmux panes (by pane id), not the GUI host
  Start-Process -FilePath 'node' -ArgumentList 'src/cli.js', 'daemon' `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" | Out-Null
  Start-Sleep -Milliseconds 1200
  $d = Get-Daemons
  if ($d) {
    Write-Host "daemon started (PID $($d.ProcessId -join ',')) - sole poller. logs: ./orch.ps1 logs"
  } else {
    Write-Host "FAILED to start; recent log:"
    if (Test-Path "$Log.err") { Get-Content "$Log.err" -Tail 5 }
    if (Test-Path $Log) { Get-Content $Log -Tail 5 }
  }
}

switch ($Action) {
  'start'   { Stop-Daemon; Start-Daemon }
  'stop'    { Stop-Daemon }
  'restart' { Stop-Daemon; Start-Daemon }
  'logs'    { if (Test-Path $Log) { Get-Content $Log -Tail 20 } else { Write-Host "no log yet" } }
  'status'  {
    $d = Get-Daemons
    if ($d) { Write-Host "daemon: RUNNING (PID $($d.ProcessId -join ','))" }
    else    { Write-Host "daemon: stopped" }
    Write-Host "--- bus ---"
    node "$Root/src/cli.js" status
  }
}
