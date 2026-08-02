$paramStartNow = $args -contains "-StartNow"
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$botRoot = Join-Path $projectRoot "bot-service"
$botEnvPath = Join-Path $botRoot ".env"
$accountsPath = Join-Path $botRoot "config\accounts.json"
$nodeExe = $null
$packageManager = $null

function Write-Title {
    Clear-Host
    Write-Host ""
    Write-Host "  NERDZONE BOT MANAGER" -ForegroundColor Red
    Write-Host "  Painel local + Mineflayer 1.8.9" -ForegroundColor DarkGray
    Write-Host ""
}

function Require-Node {
    $portableNode = Join-Path $projectRoot "runtime\node\node.exe"
    $portableNpm = Join-Path $projectRoot "runtime\node\npm.cmd"
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    $systemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    $bundledPnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"

    if ((Test-Path $portableNode) -and (Test-Path $portableNpm)) {
        $script:nodeExe = $portableNode
        $script:packageManager = $portableNpm
        $env:Path = "$(Split-Path -Parent $portableNode);$env:Path"
        Write-Host "Usando o Node portatil do Nerdzone Manager." -ForegroundColor Green
    } elseif ($systemNode -and $systemNpm) {
        $script:nodeExe = $systemNode.Source
        $script:packageManager = $systemNpm.Source
    } elseif ((Test-Path $bundledNode) -and (Test-Path $bundledPnpm)) {
        $script:nodeExe = $bundledNode
        $script:packageManager = $bundledPnpm
        $nodeBin = Split-Path -Parent $bundledNode
        $pnpmBin = Split-Path -Parent $bundledPnpm
        $env:Path = "$nodeBin;$pnpmBin;$env:Path"
        Write-Host "Usando o Node incluido no Codex." -ForegroundColor Green
    } else {
        Write-Host "Node.js nao foi encontrado." -ForegroundColor Yellow
        Write-Host "Instale o Node.js 22 ou superior em https://nodejs.org/"
        throw "Node.js ausente"
    }
    $nodeVersion = (& $script:nodeExe --version)
    $major = [int]($nodeVersion.TrimStart("v").Split(".")[0])
    if ($major -lt 22) { throw "Use Node.js 22 ou superior. Versao encontrada: $nodeVersion" }
}

function New-ApiKey {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function Ensure-Environment {
    if (-not (Test-Path $botEnvPath)) {
        $key = New-ApiKey
        @"
PORT=3100
BOT_API_KEY=$key
PANEL_ORIGIN=http://localhost:3000
MINECRAFT_HOST=nerdzone.gg
MINECRAFT_PORT=25565
MINECRAFT_VERSION=1.8.9
"@ | Set-Content -LiteralPath $botEnvPath -Encoding utf8
        Write-Host "Configuracao segura criada." -ForegroundColor Green
    }
}

function Configure-Accounts {
    Write-Title
    Write-Host "Configuracao das contas do servidor" -ForegroundColor Cyan
    Write-Host "Informe o nick e a senha usada no comando /login." -ForegroundColor DarkGray
    Write-Host ""
    do {
        $countText = Read-Host "Quantas contas deseja configurar (1 a 15)"
        $valid = [int]::TryParse($countText, [ref]$count) -and $count -ge 1 -and $count -le 15
        if (-not $valid) { Write-Host "Digite um numero entre 1 e 15." -ForegroundColor Yellow }
    } until ($valid)

    $accounts = @()
    for ($index = 1; $index -le $count; $index++) {
        do { $nickname = (Read-Host "Nick da conta $index").Trim() } until ($nickname)
        do {
            $securePassword = Read-Host "Senha do /login da conta $index" -AsSecureString
            $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
            try { $serverPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
        } until ($serverPassword)
        $suggested = if ($index -eq 1) { "principal" } else { "supra$($index - 1)" }
        $id = (Read-Host "Nome curto [$suggested]").Trim()
        if (-not $id) { $id = $suggested }
        $id = $id -replace "[^a-zA-Z0-9_-]", "-"
        $accounts += [ordered]@{ id = $id; username = $nickname; auth = "offline"; serverPassword = $serverPassword }
    }
    $accounts | ConvertTo-Json | Set-Content -LiteralPath $accountsPath -Encoding utf8
    Write-Host ""
    Write-Host "$count conta(s) configurada(s)." -ForegroundColor Green
    Start-Sleep -Seconds 1
}

function Install-Dependencies {
    $rootModules = Join-Path $projectRoot "node_modules"
    $botModules = Join-Path $botRoot "node_modules"
    if (-not (Test-Path $rootModules)) {
        Write-Host "Instalando o painel pela primeira vez..." -ForegroundColor Cyan
        Push-Location $projectRoot
        try { & $script:packageManager install; if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar o painel" } } finally { Pop-Location }
    }
    if (-not (Test-Path $botModules)) {
        Write-Host "Instalando o Mineflayer pela primeira vez..." -ForegroundColor Cyan
        Push-Location $botRoot
        try { & $script:packageManager install; if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar o Mineflayer" } } finally { Pop-Location }
    }
}

function Start-Nerdzone {
    Require-Node
    Ensure-Environment
    $needsAccounts = -not (Test-Path $accountsPath)
    if (-not $needsAccounts) {
        try {
            $savedAccounts = Get-Content -Raw -LiteralPath $accountsPath | ConvertFrom-Json
            $needsAccounts = @($savedAccounts).Count -eq 0 -or @($savedAccounts | Where-Object { $_.auth -ne "offline" -or -not $_.serverPassword }).Count -gt 0
        } catch { $needsAccounts = $true }
    }
    if ($needsAccounts) { Configure-Accounts }
    Install-Dependencies
    Write-Title
    Write-Host "Abrindo o servico dos bots..." -ForegroundColor Green
    $packageManagerCommand = "`"$script:packageManager`""
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "title Nerdzone Bots ^&^& cd /d `"$botRoot`" ^&^& call $packageManagerCommand start"
    Start-Sleep -Seconds 2
    Write-Host "Abrindo o painel..." -ForegroundColor Green
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "title Nerdzone Painel ^&^& cd /d `"$projectRoot`" ^&^& call $packageManagerCommand run dev"
    Start-Sleep -Seconds 5
    Start-Process "http://localhost:3000"
    Write-Host ""
    Write-Host "Tudo iniciado. Nao feche as duas janelas de terminal." -ForegroundColor Cyan
    Write-Host "Os bots enviarao /login automaticamente ao entrar no servidor." -ForegroundColor DarkGray
    Write-Host ""
    if (-not $paramStartNow) { Read-Host "Pressione ENTER para fechar somente este iniciador" }
}

try {
    if ($paramStartNow) {
        Start-Nerdzone
        exit 0
    }
    Write-Title
    Write-Host "[1] Iniciar painel e bots"
    Write-Host "[2] Configurar novamente as contas"
    Write-Host "[3] Sair"
    Write-Host ""
    $choice = Read-Host "Escolha"
    switch ($choice) {
        "2" { Require-Node; Ensure-Environment; Configure-Accounts; Start-Nerdzone }
        "3" { exit 0 }
        default { Start-Nerdzone }
    }
} catch {
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
