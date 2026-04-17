# taskbean install script for Windows PowerShell
# Usage: iwr -useb https://taskbean.ai/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo = 'taskbean/taskbean'
$installDir = "$env:LOCALAPPDATA\Programs\taskbean"

$binary = 'bean-windows-x64.exe'

Write-Host '🫘 fetching latest taskbean release...' -ForegroundColor Green

$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
$tag = $release.tag_name
$asset = $release.assets | Where-Object { $_.name -eq $binary }
$sumsAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS' }

if (-not $asset) {
    Write-Error "Could not find $binary in release $tag"
    exit 1
}
if (-not $sumsAsset) {
    Write-Error "Could not find SHA256SUMS in release $tag — refusing to install without checksum verification."
    exit 1
}

$url = $asset.browser_download_url
$sumsUrl = $sumsAsset.browser_download_url

Write-Host "🫘 installing taskbean $tag..." -ForegroundColor Green

New-Item -ItemType Directory -Path $installDir -Force | Out-Null

# Download into a temp file, verify, then move into place.
$tmpBin = Join-Path $env:TEMP "taskbean-$([guid]::NewGuid()).exe"
$tmpSums = Join-Path $env:TEMP "taskbean-SHA256SUMS-$([guid]::NewGuid()).txt"
try {
    Invoke-WebRequest -Uri $url -OutFile $tmpBin -UseBasicParsing
    Invoke-WebRequest -Uri $sumsUrl -OutFile $tmpSums -UseBasicParsing

    $expectedLine = Get-Content $tmpSums | Where-Object { $_ -match "\s\*?$([regex]::Escape($binary))\s*$" } | Select-Object -First 1
    if (-not $expectedLine) {
        Write-Error "SHA256SUMS does not contain an entry for $binary"
        exit 1
    }
    $expected = ($expectedLine -split '\s+')[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tmpBin).Hash.ToLower()

    if ($expected -ne $actual) {
        Write-Error "Checksum mismatch for $binary`n  expected: $expected`n  actual:   $actual"
        exit 1
    }
    Write-Host "🔒 SHA256 verified: $actual" -ForegroundColor Green

    Move-Item -Force -Path $tmpBin -Destination "$installDir\bean.exe"
} finally {
    if (Test-Path $tmpBin) { Remove-Item -Force $tmpBin -ErrorAction SilentlyContinue }
    if (Test-Path $tmpSums) { Remove-Item -Force $tmpSums -ErrorAction SilentlyContinue }
}

# Also create taskbean.exe copy
Copy-Item "$installDir\bean.exe" "$installDir\taskbean.exe" -Force

# Write install-channel marker so `bean upgrade` uses the binary self-update
# path rather than npm.
$taskbeanDir = Join-Path $env:USERPROFILE '.taskbean'
New-Item -ItemType Directory -Path $taskbeanDir -Force | Out-Null
Set-Content -Path (Join-Path $taskbeanDir '.install-channel') -Value 'binary' -NoNewline

Write-Host "✅ Installed to $installDir\bean.exe" -ForegroundColor Green

# Add to PATH if not already there
$currentPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($currentPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable('PATH', "$installDir;$currentPath", 'User')
    Write-Host "📍 Added $installDir to your PATH (restart terminal to apply)" -ForegroundColor Yellow
}

Write-Host '   Run: bean --help' -ForegroundColor Cyan
