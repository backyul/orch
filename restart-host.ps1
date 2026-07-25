#!/usr/bin/env pwsh
# One-command backend restart: kills the cockpit host (if running), then relaunches the full GUI
# stack (daemon + host + browser) via orc-gui.ps1. Agents resume with their conversations.
# Works even when the host is crashed or hung — unlike the Settings > Backend > Restart button,
# which needs a live host to receive the click.
param([int]$Port = 7610)
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$owner = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if ($owner) {
  Write-Host "stopping host (PID $owner) on :$Port..."
  Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
} else {
  Write-Host "no host on :$Port — starting fresh."
}
& "$Root/orc-gui.ps1" -Port $Port
