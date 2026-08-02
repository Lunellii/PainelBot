@echo off
setlocal
title Nerdzone - Console dos Bots
set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\node\node.exe"

if not exist "%NODE%" (
  echo Node portatil nao encontrado.
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if errorlevel 1 (
  echo Iniciando painel e servico dos bots...
  start "" "%ROOT%Abrir Painel.bat"
  timeout /t 10 /nobreak >nul
)

"%NODE%" "%ROOT%scripts\bot-console.mjs"
if errorlevel 1 pause
endlocal
