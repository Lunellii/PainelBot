@echo off
cd /d "%~dp0"
where claude >nul 2>nul
if errorlevel 1 (
  echo Claude Code nao esta instalado ou nao esta no PATH.
  echo Instale o Claude Code e execute este arquivo novamente.
  pause
  exit /b 1
)
claude .
