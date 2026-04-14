@echo off
REM taskbean — double-click launcher (delegates to PowerShell)
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0launch.ps1"
