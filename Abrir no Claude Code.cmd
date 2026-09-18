@echo off
setlocal
cd /d "%~dp0"

where claude >nul 2>nul
if errorlevel 1 (
  echo Claude Code nao foi encontrado no PATH.
  echo.
  echo Instale o Node.js 22 ou superior e depois execute:
  echo     npm install -g @anthropic-ai/claude-code
  echo.
  echo Feche e reabra o terminal apos instalar e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

set "CLAUDE_VERSION="
for /f "delims=" %%v in ('claude --version 2^>nul') do set "CLAUDE_VERSION=%%v"
if defined CLAUDE_VERSION (
  echo Claude Code: %CLAUDE_VERSION%
) else (
  echo Claude Code encontrado no PATH.
)

if /i "%~1"=="--update" (
  echo Procurando atualizacoes do Claude Code...
  claude update
  echo.
)

if not exist "node_modules" (
  echo Aviso: node_modules nao encontrado. Rode "npm install" antes de buildar o painel.
  echo.
)

echo Abrindo o PainelBot no Claude Code...
echo Dica: rode "Abrir no Claude Code.cmd" --update para atualizar o CLI antes de abrir.
echo.

claude .
exit /b %errorlevel%
