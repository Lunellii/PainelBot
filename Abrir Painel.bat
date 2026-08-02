@echo off
setlocal
title Nerdzone Bot Manager - Iniciador

set "ROOT=%~dp0"
if exist "%ROOT%Nerdzone Bot Manager Desktop.exe" (
  start "" "%ROOT%Nerdzone Bot Manager Desktop.exe"
  exit /b 0
)
set "NODE_RUNTIME=%ROOT%runtime\node"
set "PATH=%NODE_RUNTIME%;%PATH%"

rem Fecha somente consoles antigos visiveis das versoes anteriores.
taskkill /FI "WINDOWTITLE eq Nerdzone Bots*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Nerdzone Painel*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Nerdzone - Console dos Bots*" /F >nul 2>&1

if not exist "%NODE_RUNTIME%\node.exe" (
  echo ERRO: Node portatil nao encontrado.
  echo Caminho esperado: %NODE_RUNTIME%\node.exe
  pause
  exit /b 1
)

if not exist "%ROOT%bot-service\.env" (
  echo ERRO: configuracao .env nao encontrada.
  echo Abra primeiro o Nerdzone Manager.exe para criar a configuracao.
  pause
  exit /b 1
)

if not exist "%ROOT%bot-service\config\accounts.json" (
  echo ERRO: arquivo das contas nao encontrado.
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":3100 .*LISTENING" >nul
if errorlevel 1 (
  echo Iniciando bots em segundo plano...
  wscript.exe "%ROOT%scripts\start-bot-hidden.vbs"
) else (
  echo Servico dos bots ja esta ativo.
)

netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if errorlevel 1 (
  echo Iniciando painel em segundo plano...
  wscript.exe "%ROOT%scripts\start-panel-hidden.vbs"
) else (
  echo Painel ja esta ativo.
)

timeout /t 5 /nobreak >nul

timeout /t 7 /nobreak >nul

echo Abrindo o painel como aplicativo...
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "Nerdzone Bot Manager" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3000 --start-maximized
) else if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "Nerdzone Bot Manager" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000 --start-maximized
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "Nerdzone Bot Manager" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000 --start-maximized
) else (
  start "" "http://localhost:3000"
)

echo.
echo Painel iniciado. Mantenha abertas as janelas Nerdzone Bots e Nerdzone Painel.
timeout /t 3 /nobreak >nul
endlocal
