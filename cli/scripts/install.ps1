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

if (-not $asset) {
    Write-Error "Could not find $binary in release $tag"
    exit 1
}

$url = $asset.browser_download_url

Write-Host "🫘 installing taskbean $tag..." -ForegroundColor Green

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Invoke-WebRequest -Uri $url -OutFile "$installDir\bean.exe"

# Also create taskbean.exe copy
Copy-Item "$installDir\bean.exe" "$installDir\taskbean.exe" -Force

Write-Host "✅ Installed to $installDir\bean.exe" -ForegroundColor Green

# Add to PATH if not already there
$currentPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($currentPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable('PATH', "$installDir;$currentPath", 'User')
    Write-Host "📍 Added $installDir to your PATH (restart terminal to apply)" -ForegroundColor Yellow
}

Write-Host '   Run: bean --help' -ForegroundColor Cyan
