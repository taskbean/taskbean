<# taskbean — one-click launcher
   Starts the Python backend (if not already running) and opens the PWA.
   When invoked via the taskbean:// protocol handler, Windows passes the URL
   as the first argument — in that case we only start the server (the user
   already has a browser window open). #>

param([string]$ProtocolUrl = "")

$Port = 8275
$AgentDir = Join-Path $PSScriptRoot "agent"
$SkipBrowser = $ProtocolUrl -like "taskbean://*"

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
$python = if (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" }
          elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" }
          else { $null }

if (-not $python) {
    Write-Host ""
    Write-Host "Python not found." -ForegroundColor Red
    Write-Host "Install Python 3.10+ from https://python.org/downloads/" -ForegroundColor Yellow
    Write-Host "  or run:  winget install Python.Python.3.12" -ForegroundColor Yellow
    Write-Host ""
    Start-Process "https://python.org/downloads/"
    Read-Host "Press Enter after installing Python to continue"
    $python = if (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" }
              elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" }
              else { $null }
    if (-not $python) {
        Write-Host "Python still not found. Please install it and try again." -ForegroundColor Red
        exit 1
    }
}

if (-not (Get-Command foundry -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "Foundry Local not found. Installing via winget..." -ForegroundColor Yellow
    winget install Microsoft.FoundryLocal --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not install Foundry Local automatically." -ForegroundColor Red
        Write-Host "Install manually:  winget install Microsoft.FoundryLocal" -ForegroundColor Yellow
    }
}

# Install Python dependencies if needed
$reqFile = Join-Path $AgentDir "requirements.txt"
if (Test-Path $reqFile) {
    $marker = Join-Path $AgentDir ".deps-installed"
    if (-not (Test-Path $marker)) {
        Write-Host "Installing Python dependencies..." -ForegroundColor Cyan
        & $python -m pip install -r $reqFile --quiet 2>$null
        if ($LASTEXITCODE -eq 0) { New-Item -Path $marker -ItemType File -Force | Out-Null }
    }
}

# Already running?
$alive = $false
try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $alive = $true }
} catch {}

if (-not $alive) {
    Write-Host "Starting taskbean server..." -ForegroundColor Cyan
    Start-Process -FilePath $python -ArgumentList "main.py" -WorkingDirectory $AgentDir -WindowStyle Hidden

    # Wait up to 60 s for the server to become healthy
    $deadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
    }

    if (-not $ready) {
        Write-Host "Server did not become healthy within 60 s — opening anyway." -ForegroundColor Yellow
    } else {
        Write-Host "Server is ready." -ForegroundColor Green
    }
}

if (-not $SkipBrowser) {
    # Open in the default browser (Edge/Chrome will use the installed PWA if available)
    Start-Process "http://localhost:$Port"
}
