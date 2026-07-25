#Requires -Version 5.1
<#
.SYNOPSIS
  One-command interactive setup for the Agent Grid cockpit.
  Safe to re-run — skips steps that are already done.

.DESCRIPTION
  This script will:
    1. Check that Node.js >= 18, git, and claude are installed.
    2. Install Node package dependencies (npm install).
    3. Optionally set up Telegram remote control (.env with your bot token
       and chat ID) — skippable; the cockpit works without it.
    4. Optionally enable Telegram supervisor mode.
    5. Verify your bot token is working.
    6. Print the exact commands to start the cockpit.

  Press Ctrl+C at any time to abort safely — no changes are committed until
  each step completes.
#>
[CmdletBinding()]
param()

Set-StrictMode -Off    # friendlier errors for end-users on non-existent variables
$ErrorActionPreference = 'Continue'   # one bad check must NOT crash the whole script

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Banner {
    param([string]$Text)
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step {
    param([string]$Text)
    Write-Host ""
    Write-Host "--- $Text ---" -ForegroundColor Yellow
}

function Write-OK   { param([string]$t) Write-Host "  [OK]      $t" -ForegroundColor Green  }
function Write-Warn { param([string]$t) Write-Host "  [WARN]    $t" -ForegroundColor Yellow }
function Write-Fail { param([string]$t) Write-Host "  [MISSING] $t" -ForegroundColor Red    }

function Abort {
    param([string]$Reason)
    Write-Host ""
    Write-Host "Setup aborted: $Reason" -ForegroundColor Red
    Write-Host "Fix the issue above and re-run:  .\setup.ps1" -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
Write-Banner "Agent Grid Cockpit -- one-time setup"
Write-Host "This script will:"
Write-Host "  1. Check that Node.js >= 18, git, and claude CLI are installed."
Write-Host "  2. Install Node package dependencies (npm install)."
Write-Host "  3. Optionally set up Telegram remote control (.env file with a bot"
Write-Host "     token + your numeric chat ID) -- skippable; the cockpit works without it."
Write-Host "  4. Optionally enable Telegram supervisor mode (only if Telegram is set up)."
Write-Host "  5. Verify your bot token is working (only if Telegram is set up)."
Write-Host "  6. Print the exact commands to launch the cockpit."
Write-Host ""
Write-Host "You can press Ctrl+C at any time to abort safely." -ForegroundColor Gray

# ---------------------------------------------------------------------------
# STEP 1 — Prerequisite checks
# ---------------------------------------------------------------------------
Write-Step "Step 1 of 6 -- Checking prerequisites"

$prereqOk = $true

# --- Node.js >= 18 ---
$nodeOk = $false
$nodePath = $null
try {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $nodeRaw = & node --version 2>$null
    if ($nodeRaw -match '^v?(\d+)') {
        $nodeMajor = [int]$Matches[1]
        if ($nodeMajor -ge 18) {
            Write-OK "Node.js $nodeRaw (>= 18 required)"
            $nodeOk = $true
        } else {
            Write-Fail "Node.js $nodeRaw found but version 18 or newer is required."
        }
    } else {
        Write-Fail "Node.js found but could not parse version: $nodeRaw"
    }
} catch {
    Write-Fail "Node.js not found on PATH."
}
if (-not $nodeOk) {
    Write-Host "    Install Node.js from: https://nodejs.org/" -ForegroundColor Gray
    Write-Host "    (Download the LTS installer; 18 or 20 are both fine.)" -ForegroundColor Gray
    $prereqOk = $false
}

# --- git ---
$gitOk = $false
try {
    $gitRaw = & git --version 2>$null
    if ($gitRaw -match 'git version') {
        Write-OK "$gitRaw"
        $gitOk = $true
    }
} catch { }
if (-not $gitOk) {
    Write-Fail "git not found on PATH."
    Write-Host "    Install git from: https://git-scm.com/download/win" -ForegroundColor Gray
    $prereqOk = $false
}

# --- claude CLI (warn-only — the cockpit host runs without it; agents need it) ---
$claudeOk = $false
try {
    $claudeRaw = & claude --version 2>$null
    if ($LASTEXITCODE -eq 0 -or $claudeRaw) {
        Write-OK "claude CLI found ($claudeRaw)"
        $claudeOk = $true
    }
} catch { }
if (-not $claudeOk) {
    # Also try the npm bin location (common Windows install path)
    $claudeCmd = Join-Path $env:APPDATA 'npm\claude.cmd'
    if (Test-Path $claudeCmd) {
        Write-OK "claude CLI found at $claudeCmd"
        $claudeOk = $true
    }
}
if (-not $claudeOk) {
    Write-Warn "claude CLI not found. The cockpit web interface will start, but"
    Write-Host "    you won't be able to spawn AI agents until it is installed." -ForegroundColor Gray
    Write-Host "    Install guide: https://docs.anthropic.com/en/docs/claude-code" -ForegroundColor Gray
    # Warn-only: do not set $prereqOk = $false
}

if (-not $prereqOk) {
    Abort "One or more required tools are missing (see [MISSING] lines above)."
}

Write-Host ""
Write-Host "All required prerequisites are present." -ForegroundColor Green

# ---------------------------------------------------------------------------
# STEP 2 — npm install
# ---------------------------------------------------------------------------
Write-Step "Step 2 of 6 -- Installing Node.js packages"

$markerFile  = Join-Path $Root '.setup-npm-hash'
$pkgJsonPath = Join-Path $Root 'package.json'
$nodeModules = Join-Path $Root 'node_modules'

# Compute a simple hash of package.json so we can skip npm install when nothing changed.
$currentHash = ''
try {
    $pkgBytes    = [System.IO.File]::ReadAllBytes($pkgJsonPath)
    $sha         = [System.Security.Cryptography.SHA256]::Create()
    $hashBytes   = $sha.ComputeHash($pkgBytes)
    $currentHash = [BitConverter]::ToString($hashBytes) -replace '-', ''
} catch { }

$storedHash = ''
if (Test-Path $markerFile) {
    try { $storedHash = (Get-Content $markerFile -Raw).Trim() } catch { }
}

$skipInstall = ($currentHash -ne '' -and $currentHash -eq $storedHash -and (Test-Path $nodeModules))

if ($skipInstall) {
    Write-OK "node_modules is up to date — skipping npm install."
} else {
    Write-Host "  Running npm install (this may take a minute on first run)..." -ForegroundColor Gray
    Push-Location $Root
    & npm install
    $npmExit = $LASTEXITCODE
    Pop-Location
    if ($npmExit -ne 0) {
        Abort "npm install failed (exit code $npmExit). Check the output above."
    }
    # Write the hash so we skip next time
    try { Set-Content -Path $markerFile -Value $currentHash -NoNewline } catch { }
    Write-OK "npm install completed successfully."
}

# ---------------------------------------------------------------------------
# Telegram opt-in gate — the cockpit grid runs fine without Telegram.
# If .env already has a token, keep the normal review flow (no extra question).
# ---------------------------------------------------------------------------
$envPath = Join-Path $Root '.env'

$envHasToken = $false
if (Test-Path $envPath) {
    try {
        foreach ($line in (Get-Content $envPath)) {
            if ($line -match '^TELEGRAM_BOT_TOKEN=(.+)$') { $envHasToken = $true }
        }
    } catch { }
}

$doTelegram = $true
if (-not $envHasToken) {
    Write-Host ""
    Write-Host "Telegram is optional: it lets agents reach you on your phone when you" -ForegroundColor Gray
    Write-Host "step away, but the cockpit grid works fine without it." -ForegroundColor Gray
    $tgChoice = Read-Host "Set up Telegram remote control now? [y/N] (you can do this later -- the cockpit works without it)"
    if ($tgChoice -notmatch '^[Yy]') {
        $doTelegram = $false
        Write-Host "  Skipping Telegram setup. Configure it later by re-running .\setup.ps1 or via the cockpit Settings." -ForegroundColor Gray
    }
}

if ($doTelegram) {

# ---------------------------------------------------------------------------
# STEP 3 — .env creation / review
# ---------------------------------------------------------------------------
Write-Step "Step 3 of 6 -- Configuring Telegram credentials (.env)"

if (Test-Path $envPath) {
    # Parse the existing file and show a masked summary
    Write-Host "  An existing .env file was found. Current values:" -ForegroundColor Gray
    $existingToken  = ''
    $existingChatId = ''
    $existingMode   = ''
    try {
        foreach ($line in (Get-Content $envPath)) {
            if ($line -match '^TELEGRAM_BOT_TOKEN=(.+)$')    { $existingToken  = $Matches[1].Trim() }
            if ($line -match '^TELEGRAM_ALLOWED_CHAT_ID=(.+)$') { $existingChatId = $Matches[1].Trim() }
            if ($line -match '^ORCH_MODE=(.+)$')              { $existingMode   = $Matches[1].Trim() }
        }
    } catch { }

    if ($existingToken) {
        $tokenLen  = $existingToken.Length
        Write-Host "    TELEGRAM_BOT_TOKEN      : <set, $tokenLen chars>" -ForegroundColor Gray
    } else {
        Write-Host "    TELEGRAM_BOT_TOKEN      : (not set)" -ForegroundColor Yellow
    }
    if ($existingChatId) {
        Write-Host "    TELEGRAM_ALLOWED_CHAT_ID: <set, $($existingChatId.Length) chars>" -ForegroundColor Gray
    } else {
        Write-Host "    TELEGRAM_ALLOWED_CHAT_ID: (not set)" -ForegroundColor Yellow
    }
    if ($existingMode) {
        Write-Host "    ORCH_MODE               : $existingMode" -ForegroundColor Gray
    }
    Write-Host ""

    $keepEnv = $null
    while ($null -eq $keepEnv) {
        $choice = Read-Host "  Keep existing .env? [Y/n]"
        if ($choice -eq '' -or $choice -match '^[Yy]') {
            $keepEnv = $true
        } elseif ($choice -match '^[Nn]') {
            $keepEnv = $false
        } else {
            Write-Host "  Please type Y or N." -ForegroundColor Yellow
        }
    }

    if ($keepEnv) {
        Write-OK ".env kept as-is."
        # Skip to step 4 — supervisor mode will be offered later only if not already set.
        # We set a flag so step 4 knows whether to prompt.
        $envJustCreated = $false
    } else {
        Write-Host "  OK — will overwrite .env." -ForegroundColor Gray
        $envJustCreated = $true
    }
} else {
    Write-Host "  No .env file found — let's create one now." -ForegroundColor Gray
    $envJustCreated = $true
}

# Only collect credentials if we are creating/overwriting
if ($envJustCreated) {

    # --- 3a. Bot token ---
    Write-Host ""
    Write-Host "  === Create a Telegram bot ===" -ForegroundColor Cyan
    Write-Host "  1. Open Telegram and search for @BotFather (the official bot from Telegram)."
    Write-Host "  2. Send:  /newbot"
    Write-Host "  3. Choose a display name (e.g. 'My Agent Grid')."
    Write-Host "  4. Choose a username that ends in _bot (e.g. 'myagentgrid_bot')."
    Write-Host "  5. BotFather will reply with a token that looks like:"
    Write-Host "       1234567890:ABCDEFGhijklmnopqrstuvwxyz12345678901" -ForegroundColor Gray
    Write-Host "  Copy that token and paste it below (it won't be echoed on screen)."
    Write-Host ""

    $botToken = $null
    $tokenPattern = '^[0-9]{8,10}:[A-Za-z0-9_\-]{30,50}$'
    while ($null -eq $botToken) {
        $raw = Read-Host "  Paste your Telegram bot token" -AsSecureString
        # Convert SecureString to plain text (PS5.1-compatible)
        $bstr  = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($raw)
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        $plain = $plain.Trim()

        if ($plain -match $tokenPattern) {
            $botToken = $plain
            Write-OK "Token format looks valid ($($botToken.Length) chars)."
        } else {
            Write-Host "  That doesn't look like a valid bot token." -ForegroundColor Red
            Write-Host "  Expected format: 8-10 digits, colon, then 30-50 letters/numbers/dashes." -ForegroundColor Gray
            Write-Host "  Example:  1234567890:ABCDEFGhijklmnopqrstuvwxyz12345678901" -ForegroundColor Gray
            Write-Host "  Make sure you copied the FULL token from BotFather, then try again." -ForegroundColor Gray
            Write-Host ""
        }
    }

    # --- 3b. Chat ID ---
    Write-Host ""
    Write-Host "  === Find your Telegram chat ID ===" -ForegroundColor Cyan
    Write-Host "  1. Open Telegram and search for @userinfobot (or @getidsbot)."
    Write-Host "  2. Send it any message (e.g. /start)."
    Write-Host "  3. It will reply with your numeric ID, e.g.  987654321"
    Write-Host "  That number is what you enter below."
    Write-Host "  (Only messages from this chat ID will be accepted by the cockpit.)"
    Write-Host ""

    $chatId = $null
    $chatIdPattern = '^-?[0-9]{5,15}$'
    while ($null -eq $chatId) {
        $raw = Read-Host "  Your Telegram numeric chat ID"
        $raw = $raw.Trim()
        if ($raw -match $chatIdPattern) {
            $chatId = $raw
            Write-OK "Chat ID accepted."
        } else {
            Write-Host "  That doesn't look like a numeric Telegram chat ID." -ForegroundColor Red
            Write-Host "  It should be 5-15 digits (may start with a minus sign for groups)." -ForegroundColor Gray
            Write-Host "  Send /start to @userinfobot and copy the number it gives you." -ForegroundColor Gray
            Write-Host ""
        }
    }

    # Write .env (token is never echoed)
    $envContent = "TELEGRAM_BOT_TOKEN=$botToken`nTELEGRAM_ALLOWED_CHAT_ID=$chatId`n"
    try {
        Set-Content -Path $envPath -Value $envContent -NoNewline -Encoding UTF8
        Write-OK ".env written (token stored, not displayed)."
    } catch {
        Abort "Could not write .env file: $_"
    }
}

# ---------------------------------------------------------------------------
# STEP 4 — Supervisor mode (optional)
# ---------------------------------------------------------------------------
Write-Step "Step 4 of 6 -- Optional: Telegram supervisor mode"

Write-Host "  Supervisor mode lets a headless Claude session answer your Telegram messages" -ForegroundColor Gray
Write-Host "  automatically. Without it, you manage agents through the cockpit web UI only." -ForegroundColor Gray
Write-Host "  (You can change this later by editing .env and adding ORCH_MODE=supervisor.)" -ForegroundColor Gray
Write-Host ""

# Check whether ORCH_MODE is already set in .env
$currentMode = ''
try {
    foreach ($line in (Get-Content $envPath)) {
        if ($line -match '^ORCH_MODE=(.+)$') { $currentMode = $Matches[1].Trim() }
    }
} catch { }

if ($currentMode -eq 'supervisor') {
    Write-OK "Supervisor mode is already enabled in .env (ORCH_MODE=supervisor)."
} else {
    $enableSupervisor = $false
    $svChoice = Read-Host "  Enable Telegram supervisor mode? [y/N]"
    if ($svChoice -match '^[Yy]') {
        $enableSupervisor = $true
    }

    if ($enableSupervisor) {
        # Append ORCH_MODE=supervisor to .env
        try {
            $existing = Get-Content $envPath -Raw
            # Remove any stale ORCH_MODE line first
            $existing = ($existing -split "`n" | Where-Object { $_ -notmatch '^ORCH_MODE=' }) -join "`n"
            $existing = $existing.TrimEnd() + "`nORCH_MODE=supervisor`n"
            Set-Content -Path $envPath -Value $existing -NoNewline -Encoding UTF8
            Write-OK "Supervisor mode enabled (ORCH_MODE=supervisor added to .env)."
            Write-Host "  The daemon will run a background Claude session that reads and replies" -ForegroundColor Gray
            Write-Host "  to Telegram messages on your behalf when you are away from the cockpit." -ForegroundColor Gray
        } catch {
            Write-Warn "Could not update .env to add ORCH_MODE: $_"
        }
    } else {
        Write-OK "Supervisor mode skipped. Standard cockpit-only mode."
    }
}

# ---------------------------------------------------------------------------
# STEP 5 — Bot token smoke check
# ---------------------------------------------------------------------------
Write-Step "Step 5 of 6 -- Verifying bot token with Telegram"

# Read the token back from .env (we never keep it in a variable across steps if user kept existing)
$checkToken = ''
try {
    foreach ($line in (Get-Content $envPath)) {
        if ($line -match '^TELEGRAM_BOT_TOKEN=(.+)$') { $checkToken = $Matches[1].Trim() }
    }
} catch { }

if (-not $checkToken) {
    Write-Warn "Could not read token from .env — skipping bot verification."
} else {
    Write-Host "  Contacting Telegram to confirm the bot is reachable..." -ForegroundColor Gray
    $verified = $false
    try {
        $response = Invoke-RestMethod -Uri "https://api.telegram.org/bot$checkToken/getMe" `
            -Method Get -TimeoutSec 10 -ErrorAction Stop
        if ($response.ok -and $response.result) {
            $username = $response.result.username
            Write-OK "Bot @$username verified successfully."
            $verified = $true
        } else {
            Write-Warn "Telegram returned ok=false. Double-check your bot token."
        }
    } catch {
        $msg = $_.Exception.Message
        Write-Warn "Could not reach Telegram API: $msg"
        Write-Host "  This may be a network issue. Setup will continue, but you should verify" -ForegroundColor Gray
        Write-Host "  the token is correct before launching the cockpit." -ForegroundColor Gray
    }
    if (-not $verified) {
        Write-Host "  If the token is wrong, re-run setup.ps1 and choose to overwrite .env." -ForegroundColor Gray
    }
}

} # end of Telegram section (steps 3-5, skipped when $doTelegram is $false)

# ---------------------------------------------------------------------------
# STEP 6 — Done! Print launch commands
# ---------------------------------------------------------------------------
Write-Step "Step 6 of 6 -- Setup complete"

Write-Host ""
Write-Host "  Setup is complete. Here is how to use the cockpit:" -ForegroundColor Green
Write-Host ""
Write-Host "  START the cockpit (PTY host + Telegram daemon + opens browser):" -ForegroundColor Cyan
Write-Host "    .\orc-gui.ps1" -ForegroundColor White
Write-Host "    Then open:  http://127.0.0.1:7610/" -ForegroundColor Gray
Write-Host "    Click '+ Add agent' to spawn a Claude Code session in the browser grid." -ForegroundColor Gray
Write-Host ""
Write-Host "  RESTART after a crash or code change (host + daemon, agents auto-resume):" -ForegroundColor Cyan
Write-Host "    .\restart-host.ps1" -ForegroundColor White
Write-Host ""
Write-Host "  CHECK daemon status / VIEW logs:" -ForegroundColor Cyan
Write-Host "    .\orch-gui.ps1 status    -- is the Telegram daemon running?" -ForegroundColor White
Write-Host "    .\orch-gui.ps1 logs      -- tail the daemon log" -ForegroundColor White
Write-Host ""
Write-Host "  STOP everything:" -ForegroundColor Cyan
Write-Host "    .\orch-gui.ps1 stop      -- stop the Telegram daemon" -ForegroundColor White
Write-Host "    (Close the browser tab to hide the cockpit; the host keeps running.)" -ForegroundColor Gray
Write-Host ""
Write-Host "  For more detail see README.md." -ForegroundColor Gray
Write-Host ""

exit 0
