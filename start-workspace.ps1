#!/usr/bin/env pwsh
# One-command workspace: a tiled tmux grid with the orchestrator + one pane per worker.
#
#   ./start-workspace.ps1 w1 w2 w3
#   ./start-workspace.ps1               # defaults to a single worker 'w1'
#   ./start-workspace.ps1 -NoOrch w1 w2 # supervisor mode: dashboard + workers only (no orch pane)
#
# It ensures the daemon is running (hidden singleton), launches the orchestrator agent in
# the first pane, then one pane per worker name, tiles them, and attaches you.
#   Ctrl-b z  zoom the focused pane full-screen (toggle)   Ctrl-b <arrow>  move between panes
#   Ctrl-b d  detach (everything keeps running)            tmux attach -t omc  to return
param([switch]$NoOrch, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Workers)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Session = 'omc'

# Did the caller pass explicit worker names? (vs. bare `orc-start` -> default w1)
$NamesPassed = [bool]($Workers -and $Workers.Count -gt 0)

# 'all' expands to the workers currently registered, so you don't have to retype them.
# e.g. `orc-start all` rebuilds the current set; `orc-start all Raggi` keeps them and adds Raggi.
if ($NamesPassed -and ($Workers -contains 'all')) {
  $current = @()
  try {
    $s = (node "$Root/src/cli.js" status | ConvertFrom-Json).state
    $current = @($s.workers.PSObject.Properties.Name | Where-Object { $_ -ne $s.orchestratorWorker })
  } catch { }
  $extra = @($Workers | Where-Object { $_ -ne 'all' })
  $Workers = @($current + $extra | Select-Object -Unique)
}
if (-not $Workers -or $Workers.Count -eq 0) { $Workers = @('w1') }

# 1. Daemon — hidden singleton (safe to call even if already running).
& "$Root/orch.ps1" start | Out-Null

# 2. Workspace already exists?
#    - Explicit names passed  -> you want THESE workers: tear the old one down and rebuild.
#    - No names (bare orc-start) -> just re-attach to what's running.
#    Resolve instead of `has-session -t omc`: after an interactive detach psmux renames the
#    session to "omc-<user>-<host>-detached-<ts>", which `has-session -t omc` misses — that's
#    the bug where orc-start "stops working" once you've detached and come back.
$existing = (& "$Root/orc-session.ps1" resolve)
if ($existing) {
  if ($NamesPassed) {
    if ($env:TMUX) { Write-Error "Run this from a normal shell, not inside the '$Session' workspace (it would kill the pane you're in)."; return }
    Write-Host "Rebuilding workspace '$Session' with: $($Workers -join ', ') (replacing the existing one)..."
    & "$Root/orc-session.ps1" kill | Out-Null   # kills ALL omc-family sessions, incl. mangled leftovers
    Start-Sleep -Milliseconds 300
    # fall through to build a fresh session
  } else {
    Write-Host "Workspace '$Session' already exists - attaching. (Pass worker names to rebuild it, e.g. orc-start backend tests)"
    & "$Root/orc-session.ps1" attach   # normalizes a mangled name back to 'omc', then attaches
    return
  }
}

# 3. New session, built as:
#      +--------------+----------+
#      | dashboard    | worker 1 |
#      +--------------+ worker 2 |   LEFT column : dashboard (top) + orchestrator (bottom)
#      | orchestrator | worker 3 |   RIGHT column: one pane per worker, evenly split
#      +--------------+----------+
#    In -NoOrch mode the left column has only the dashboard (no orchestrator pane).
#    Target every pane by its REAL pane id (not the session's "active" pane) — after a
#    split the active pane is ambiguous, which leaks send-keys into the wrong pane.
#    `split-window -P -F '#{pane_id}'` prints the new pane id so we hit it exactly.
node "$Root/src/cli.js" reset-workers | Out-Null   # clean slate: dashboard lists only this run's workers

tmux new-session -d -s $Session -x 240 -y 60
$dashPane = (tmux list-panes -t $Session -F '#{pane_id}' | Select-Object -First 1).Trim()
$winH = [int]((tmux display-message -p -t $Session '#{window_height}').Trim())

# Vertical divide first: split off the RIGHT column (it becomes worker #1).
$rightFirst = (tmux split-window -h -t $dashPane -P -F '#{pane_id}').Trim()

if ($NoOrch) {
  # Supervisor mode: no orchestrator pane — the headless Supervisor (daemon-driven) coordinates.
  tmux set-option -t $Session pane-border-status top | Out-Null
  tmux set-option -t $Session pane-border-format '┤ #{pane_title} ├' | Out-Null
  tmux select-pane -t $dashPane -T 'DASHBOARD' | Out-Null
  tmux send-keys -t $dashPane "cd `"$Root`"; node src/dashboard.js" Enter
} else {
  # Split the LEFT column horizontally: dashboard on top, orchestrator beneath it.
  $orchPane = (tmux split-window -v -t $dashPane -P -F '#{pane_id}').Trim()
  # Keep the dashboard compact; the orchestrator gets the rest of the left column.
  $dashH = [Math]::Min($winH - 10, [Math]::Max(12, $Workers.Count * 2 + 9))
  tmux resize-pane -t $dashPane -y $dashH | Out-Null
  # Label every pane with a title bar (shown along its top border) so you can tell
  # them apart at a glance. Worker panes get their name in the worker-launch loop below.
  # NOTE: this 'tmux' is psmux (the Windows emulation). It substitutes #{...} vars but
  # does NOT interpret #[...] style/color codes, so we make titles stand out with plain
  # box characters + UPPERCASE names instead of bold/color.
  tmux set-option -t $Session pane-border-status top | Out-Null
  tmux set-option -t $Session pane-border-format '┤ #{pane_title} ├' | Out-Null
  tmux select-pane -t $dashPane -T 'DASHBOARD' | Out-Null
  tmux select-pane -t $orchPane -T 'ORCH (orchestrator)' | Out-Null
  tmux send-keys -t $dashPane "cd `"$Root`"; node src/dashboard.js" Enter
  tmux send-keys -t $orchPane "cd `"$Root`"; ./start-orchestrator.ps1 orch" Enter
}
Start-Sleep -Seconds 2

# 4. Right column: one pane per worker. The first worker uses the right pane we already
#    made; each additional worker splits the previous worker pane.
$workerPanes = @($rightFirst)
for ($i = 1; $i -lt $Workers.Count; $i++) {
  $wp = (tmux split-window -v -t $workerPanes[-1] -P -F '#{pane_id}').Trim()
  $workerPanes += $wp
}
# Repeated splits leave the column lopsided — even out the heights.
if ($workerPanes.Count -gt 1) {
  $each = [Math]::Floor($winH / $workerPanes.Count)
  for ($i = 0; $i -lt $workerPanes.Count - 1; $i++) {
    tmux resize-pane -t $workerPanes[$i] -y $each | Out-Null
  }
}
# Launch each worker (staggered so their state.json registrations settle in order).
for ($i = 0; $i -lt $Workers.Count; $i++) {
  tmux select-pane -t $workerPanes[$i] -T $Workers[$i].ToUpper() | Out-Null
  tmux send-keys -t $workerPanes[$i] "cd `"$Root`"; ./start-worker.ps1 $($Workers[$i])" Enter
  Start-Sleep -Milliseconds 1500
}

Write-Host "Workspace '$Session' ready: dashboard + $(if ($NoOrch) { 'workers (supervisor mode)' } else { 'orchestrator + ' })$($Workers -join ', '). Ctrl-b z to zoom a pane, Ctrl-b d to detach."
tmux attach -t $Session
