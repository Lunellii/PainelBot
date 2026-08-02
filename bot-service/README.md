# Serviço dos bots

Este processo Node.js mantém até 15 conexões Mineflayer fora do navegador. Ele usa `1.8.9` por padrão, guarda sessões Microsoft apenas em `data/auth/` e exige uma chave privada em todas as chamadas.

1. Copie `.env.example` para `.env` e altere `BOT_API_KEY`.
2. Copie `config/accounts.example.json` para `config/accounts.json` e informe as contas.
3. Instale com `npm install` e execute com `npm start`.

O arquivo `.env` é carregado automaticamente pelos comandos `start` e `dev`.

Para contas offline/piratas, use `auth: "offline"`, o nick em `username` e a senha interna do servidor em `serverPassword`. Depois de entrar, o bot envia `/login senha` automaticamente. O arquivo real `accounts.json` é ignorado pelo Git e deve permanecer somente neste computador.
