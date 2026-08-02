# PainelBot

Painel local para gerenciar contas de Minecraft, automações e comandos em lote.
O projeto usa Next/Vite no painel, Electron no aplicativo desktop e Mineflayer
no serviço de conexão dos bots.

## Requisitos

- Windows 10/11
- Node.js 22 ou superior
- Java não é necessário para o painel
- Acesso ao servidor Minecraft configurado

## Instalação

```bash
npm install
cd bot-service
npm install
cd ..
```

Copie os arquivos de exemplo da pasta `bot-service/config/` para arquivos de
configuração locais. Eles são ignorados pelo Git para não publicar senhas,
proxies ou dados pessoais.

## Executar no Windows

Use `Abrir Painel.bat` ou abra `Nerdzone Manager.exe`. O iniciador sobe o
serviço dos bots e o painel local. Também é possível executar:

```bash
npm run dev
```

O painel fica disponível em `http://localhost:3000` e a API do serviço em
`http://localhost:3100`.

## Desenvolvimento

```bash
npm run build       # valida o build do painel
npm test            # executa os testes disponíveis
```

Principais diretórios:

- `app/`: interface do painel;
- `bot-service/src/`: API e automações Mineflayer;
- `electron/`: aplicativo desktop;
- `scripts/`: iniciadores e utilitários do Windows;
- `db/` e `drizzle/`: schema e migrações;
- `assets/`: ícones do aplicativo.

## Segurança

Não versione `accounts.json`, `proxies.json`, `server.json`, senhas, tokens,
logs ou `node_modules`. Use os arquivos `.example.json` como modelo e mantenha
as credenciais apenas na máquina local.

## Limitações

O repositório contém o código-fonte e os scripts necessários. Executáveis
gerados, logs e dependências instaladas não fazem parte do Git; eles devem ser
gerados localmente com as ferramentas do projeto.
