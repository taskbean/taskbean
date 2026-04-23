<# taskbean — one-click launcher
   Starts the Python backend (if not already running) and opens the PWA.
   When invoked via the taskbean:// protocol handler, Windows passes the URL
   as the first argument — in that case we only start the server (the user
   already has a browser window open). #>

param(
    [string]$ProtocolUrl = "",
    [ValidateSet('foreground','background')][string]$Mode = ''
)

$Port = 8275
$AgentDir = Join-Path $PSScriptRoot "agent"
$SkipBrowser = $ProtocolUrl -like "taskbean://*"

# Mode resolution: protocol-handler invocations are always background (no
# console attached). Explicit -Mode overrides auto-detection.
if (-not $Mode) {
    $Mode = if ($SkipBrowser) { 'background' } else { 'foreground' }
}
$IsBackground = $Mode -eq 'background'

# Structured error reporting. In background mode the launcher has no console,
# so any "we couldn't start" condition is written to a JSON error file the
# /api/launch-errors endpoint surfaces back to the PWA. In foreground mode
# we still write the file (so post-mortem inspection works) but also print
# to the console for the developer running the script directly.
$LaunchLogFile = Join-Path $env:TEMP "taskbean-launch.log"
$LaunchLogMaxEntries = 50

function Write-LaunchError {
    param(
        [Parameter(Mandatory)][string]$Code,
        [Parameter(Mandatory)][string]$Message,
        [string]$Detail = ''
    )
    $payload = @{
        code = $Code
        message = $Message
        detail = $Detail
        timestamp = (Get-Date).ToUniversalTime().ToString('o')
        mode = $Mode
        protocolUrl = $ProtocolUrl
    } | ConvertTo-Json -Compress
    # Append-as-JSONL with naive cap. Single launcher process at a time
    # (named-mutex above), so no contention. Read-modify-write is fine.
    try {
        $existing = @()
        if (Test-Path $LaunchLogFile) {
            $existing = @(Get-Content $LaunchLogFile -ErrorAction SilentlyContinue)
        }
        $combined = @($existing) + @($payload)
        if ($combined.Count -gt $LaunchLogMaxEntries) {
            $combined = $combined | Select-Object -Last $LaunchLogMaxEntries
        }
        Set-Content -Path $LaunchLogFile -Value $combined -Encoding UTF8 -ErrorAction Stop
    } catch {}
    if (-not $IsBackground) {
        Write-Host ""
        Write-Host "[$Code] $Message" -ForegroundColor Red
        if ($Detail) { Write-Host $Detail -ForegroundColor DarkGray }
    }
}

# ── Self-register taskbean:// protocol handler (best-effort, non-blocking) ────
try {
    $launchPs1 = Join-Path $PSScriptRoot "launch.ps1"
    $cmdValue = "powershell.exe -ExecutionPolicy Bypass -NoProfile -File `"$launchPs1`" `"%1`""
    $regBase = 'HKCU:\Software\Classes\taskbean'
    New-Item -Path $regBase -Force | Out-Null
    Set-ItemProperty -Path $regBase -Name '(Default)' -Value 'URL:taskbean Protocol'
    New-ItemProperty -Path $regBase -Name 'URL Protocol' -Value '' -Force | Out-Null
    New-Item -Path "$regBase\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path "$regBase\shell\open\command" -Name '(Default)' -Value $cmdValue
    Write-Host "Protocol handler taskbean:// registered." -ForegroundColor DarkGray
} catch {
    Write-Host "Could not register protocol handler (non-fatal): $_" -ForegroundColor Yellow
}

# ── Prerequisites check ───────────────────────────────────────────────────────
# Resolve a REAL Python interpreter, skipping the Microsoft Store App Execution
# Alias stubs in %LOCALAPPDATA%\Microsoft\WindowsApps\ (python.exe / python3.exe
# reparse points that open the Store and exit without running anything).
function Resolve-RealPython {
    foreach ($name in 'python','python3') {
        $hit = Get-Command $name -All -ErrorAction SilentlyContinue |
               Where-Object { $_.Source -and $_.Source -notmatch '\\WindowsApps\\' } |
               Select-Object -First 1
        if ($hit) { return $hit.Source }
    }
    return $null
}
$python = Resolve-RealPython

if (-not $python) {
    if ($IsBackground) {
        # No console -> never prompt. Surface a structured error and bail.
        Write-LaunchError -Code 'PYTHON_MISSING' `
            -Message 'Python 3.10+ is required but was not found on PATH.' `
            -Detail 'Install from https://python.org/downloads/ or run: winget install Python.Python.3.12'
        exit 2
    }
    Write-Host ""
    Write-Host "Python not found." -ForegroundColor Red
    Write-Host "Install Python 3.10+ from https://python.org/downloads/" -ForegroundColor Yellow
    Write-Host "  or run:  winget install Python.Python.3.12" -ForegroundColor Yellow
    Write-Host ""
    Start-Process "https://python.org/downloads/"
    Read-Host "Press Enter after installing Python to continue"
    $python = Resolve-RealPython
    if (-not $python) {
        Write-LaunchError -Code 'PYTHON_MISSING' `
            -Message 'Python 3.10+ is required but was not found on PATH after install prompt.' `
            -Detail 'Install from https://python.org/downloads/ or run: winget install Python.Python.3.12'
        exit 2
    }
}

if (-not (Get-Command foundry -ErrorAction SilentlyContinue)) {
    if ($IsBackground) {
        # winget is interactive (UAC, license prompts) -> never auto-install in background.
        Write-LaunchError -Code 'FOUNDRY_MISSING' `
            -Message 'Foundry Local is not installed.' `
            -Detail 'Run: winget install Microsoft.FoundryLocal'
        exit 3
    }
    Write-Host ""
    Write-Host "Foundry Local not found. Installing via winget..." -ForegroundColor Yellow
    winget install Microsoft.FoundryLocal --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not install Foundry Local automatically." -ForegroundColor Red
        Write-Host "Install manually:  winget install Microsoft.FoundryLocal" -ForegroundColor Yellow
    }
}

# ── Python virtual environment ────────────────────────────────────────────────
# We install dependencies into a repo-local virtual environment (app/.venv)
# so the running server is hermetically isolated from changes to the system
# Python install path. This eliminates the "I uninstalled Python 3.11 and
# now the launcher picks up an incompatible 3.13" class of breakage. The
# bootstrap python ($python from Resolve-RealPython) is used only to create
# the venv and is then discarded — all subsequent commands use the venv.
$VenvDir = Join-Path $AgentDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

function Ensure-Venv {
    if (Test-Path $VenvPython) { return $true }
    Write-Host "Creating virtual environment at app\.venv (one-time setup)..." -ForegroundColor Cyan
    & $python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPython)) {
        Write-LaunchError -Code 'VENV_CREATE_FAILED' `
            -Message 'Could not create the virtual environment at app\.venv.' `
            -Detail "Bootstrap python: $python (exit $LASTEXITCODE). Try deleting app\.venv and re-running."
        if ($IsBackground) { exit 4 }
        Write-Host "Could not create venv — falling back to system python." -ForegroundColor Yellow
        return $false
    }
    return $true
}

if (Ensure-Venv) { $python = $VenvPython }

# Install / refresh Python dependencies. The deps stamp lives inside the
# venv (so it is invalidated automatically when the venv is rebuilt) and
# records the SHA256 of requirements.txt from the last successful install.
# Switching the system Python no longer triggers spurious reinstalls; only
# editing requirements.txt or rebuilding the venv does.
$reqFile = Join-Path $AgentDir "requirements.txt"
$venvOk = Test-Path $VenvPython
if ($venvOk -and (Test-Path $reqFile)) {
    $stamp = Join-Path $VenvDir ".deps-stamp"
    $legacyMarker = Join-Path $AgentDir ".deps-installed"
    $reqHash = (Get-FileHash -Path $reqFile -Algorithm SHA256).Hash
    $needInstall = $true
    if (Test-Path $stamp) {
        $existing = ((Get-Content $stamp -Raw -ErrorAction SilentlyContinue) -as [string]).Trim()
        if ($existing -eq $reqHash) { $needInstall = $false }
    }
    if ($needInstall) {
        Write-Host "Installing Python dependencies into app\.venv..." -ForegroundColor Cyan
        & $python -m pip install -r $reqFile --quiet 2>$null
        if ($LASTEXITCODE -eq 0) {
            Set-Content -Path $stamp -Value $reqHash -Encoding ASCII
            # Migration: legacy marker in $AgentDir is no longer authoritative
            # because it was interpreter-agnostic. Remove it once the venv has
            # a successful install.
            if (Test-Path $legacyMarker) { Remove-Item $legacyMarker -Force -ErrorAction SilentlyContinue }
        } else {
            Write-LaunchError -Code 'PIP_INSTALL_FAILED' `
                -Message 'pip install -r requirements.txt failed.' `
                -Detail "Interpreter: $python (exit $LASTEXITCODE)"
            if ($IsBackground) { exit 5 }
        }
    }
} elseif (-not $venvOk -and (Test-Path $reqFile)) {
    # Venv creation failed and we fell back to system python. We deliberately
    # do NOT pip-install into the system interpreter — that would (a) pollute
    # the user's global site-packages and (b) fail outright on PEP 668
    # externally-managed installs. Surface a clear error and let the launch
    # attempt fail with a useful message instead.
    Write-LaunchError -Code 'VENV_REQUIRED' `
        -Message 'A virtual environment is required to install dependencies, but app\.venv could not be created.' `
        -Detail 'Delete app\.venv if it exists and re-run, or create it manually with: python -m venv app\.venv'
    if ($IsBackground) { exit 4 }
    # Foreground: do NOT continue. Without deps the server would die later
    # with a cryptic ImportError, masking the real cause. Pause so the user
    # actually sees the message before the window closes (interactive launch
    # is typically a double-click that closes on exit).
    Write-Host ""
    Write-Host "Cannot continue without a working virtual environment." -ForegroundColor Yellow
    Write-Host "See error log at $env:TEMP\taskbean-launch.log" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Press any key to exit..." -ForegroundColor DarkGray
    [void][System.Console]::ReadKey($true)
    exit 4
}

# ── Single-instance guard ─────────────────────────────────────────────────────
# A global named mutex prevents two concurrent Reconnect clicks (or a click
# racing with the Startup-folder launcher) from both spawning python children.
# The loser exits immediately; the winner owns the startup sequence.
$mutex = New-Object System.Threading.Mutex($false, 'Global\TaskBeanLauncher')
$ownMutex = $false
try { $ownMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownMutex = $true }
if (-not $ownMutex) {
    Write-Host "Another taskbean launcher is already starting the server — exiting." -ForegroundColor Yellow
    if (-not $SkipBrowser) { Start-Process "http://127.0.0.1:$Port" }
    exit 0
}

try {

# Probe — use 127.0.0.1 explicitly to match uvicorn's bind (main.py passes
# host="127.0.0.1" to uvicorn.run; resolving "localhost" can hit ::1 first
# on Windows 10+ and false-fail even when the server is up).
function Test-ServerHealth {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -ErrorAction Stop
        return $h
    } catch {
        return $null
    }
}

# Already running?
$alive = $false
$existing = Test-ServerHealth
if ($existing -and $existing.modelReady) {
    $alive = $true
    Write-Host "taskbean already running (model: $($existing.model))." -ForegroundColor Green
} elseif ($existing) {
    # Server is up but not ready — let the retry loop below decide what to do.
    Write-Host "taskbean server is up but model is not ready — waiting for readiness." -ForegroundColor Yellow
}

if (-not $alive) {
    # Foundry Local EP registration is empirically flaky on cold boot; failures
    # are recorded in startup_error without crashing the web server, and only
    # a fresh process restart recovers. We retry up to 3 times on startupError.
    $maxAttempts = 3
    $attemptBudget = 60   # seconds per attempt to reach modelReady
    $success = $false
    $lastError = $null

    for ($attempt = 1; $attempt -le $maxAttempts -and -not $success; $attempt++) {
        # Only spawn a child if the server isn't already listening. On attempt
        # 1 with a dead server we spawn; on retries after a startupError we
        # spawn a fresh process because the existing one is stuck.
        $proc = $null
        $existing = Test-ServerHealth
        if (-not $existing) {
            Write-Host "Starting taskbean server (attempt $attempt/$maxAttempts)..." -ForegroundColor Cyan
            $proc = Start-Process -FilePath $python -ArgumentList "main.py" `
                -WorkingDirectory $AgentDir -WindowStyle Hidden -PassThru
        } elseif ($attempt -gt 1) {
            # Server is up from the previous attempt but wedged — identify the
            # child process so we can kill it before restarting.
            $conn = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
            if ($conn.Count -gt 0) {
                $pidToKill = [int]$conn[0].OwningProcess
                if ($pidToKill -gt 0) {
                    Write-Host "Restarting stuck server (PID $pidToKill)..." -ForegroundColor Yellow
                    Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
                    Start-Sleep -Seconds 2
                }
            }
            $proc = Start-Process -FilePath $python -ArgumentList "main.py" `
                -WorkingDirectory $AgentDir -WindowStyle Hidden -PassThru
        }

        # Poll /api/health and parse the JSON response. Three terminal states:
        #   modelReady=true       -> success
        #   startupError set      -> retryable (kill + respawn)
        #   child process exited  -> non-retryable (crash during import)
        $deadline = (Get-Date).AddSeconds($attemptBudget)
        $retryThisAttempt = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500

            if ($proc -and $proc.HasExited) {
                $lastError = "Python process exited immediately (exit code $($proc.ExitCode)). Check that requirements are installed."
                Write-Host "  ✗ $lastError" -ForegroundColor Red
                break
            }

            $h = Test-ServerHealth
            if (-not $h) { continue }

            if ($h.modelReady) {
                Write-Host "Server is ready (model: $($h.model))." -ForegroundColor Green
                $success = $true
                break
            }

            if ($h.startupError) {
                $snippet = if ($h.startupError.Length -gt 120) { $h.startupError.Substring(0, 120) + '…' } else { $h.startupError }
                Write-Host "  startupError on attempt $attempt : $snippet" -ForegroundColor Yellow
                $lastError = $h.startupError
                $retryThisAttempt = $true
                break
            }
            # Otherwise: web server is up but still initializing — keep polling.
        }

        if (-not $success -and $attempt -lt $maxAttempts -and $retryThisAttempt) {
            Start-Sleep -Seconds 5
        }
    }

    if (-not $success) {
        if ($lastError) {
            Write-Host "Server did not become ready after $maxAttempts attempts. Last error: $lastError" -ForegroundColor Yellow
            Write-LaunchError -Code 'STARTUP_FAILED' `
                -Message "Server did not become ready after $maxAttempts attempts." `
                -Detail $lastError
        } else {
            Write-Host "Server did not become ready within the timeout — opening anyway." -ForegroundColor Yellow
            Write-LaunchError -Code 'STARTUP_TIMEOUT' `
                -Message "Server did not become ready within $($maxAttempts * $attemptBudget) seconds." `
                -Detail 'No startupError reported by /api/health; the model load is taking longer than expected.'
        }
    } else {
        # Successful start (possibly after retries). The launch log keeps a
        # rolling history of the last 50 entries so users can review prior
        # issues from the Diagnostics tab in stats-for-nerds — we deliberately
        # do NOT clear it on success.
    }
}

# Already-running short-circuit also counts as success; nothing to clear.
if ($alive) { }

if (-not $SkipBrowser) {
    # Use 127.0.0.1 to match uvicorn's bind (see note on Test-ServerHealth).
    Start-Process "http://127.0.0.1:$Port"
}

} finally {
    if ($ownMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
