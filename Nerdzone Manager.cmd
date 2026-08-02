@echo off
title Nerdzone Bot Manager
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\nerdzone-launcher.ps1"
if errorlevel 1 pause
