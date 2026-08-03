# PainelBot — contexto do projeto

Este é um painel local para gerenciar contas Mineflayer por grupos e proxies fixos.

## Estrutura

- `app/`: interface do painel (React/Vinext).
- `bot-service/src/server.mjs`: serviço local e automações Mineflayer.
- `electron/`: empacotamento do aplicativo desktop.
- `scripts/`: inicialização do painel e do serviço.
- `dist/`: build gerado; não editar manualmente.

## Regras importantes

- Nunca usar conexão direta como fallback para contas configuradas com proxy.
- Nunca trocar uma conta de proxy ou renomear contas automaticamente.
- Não ler, imprimir ou versionar credenciais e dados privados.
- Arquivos privados ficam em `bot-service/config/`, `.env` e no diretório de dados do usuário.
- Após alterar `app/`, gerar o build com `vinext build` antes de testar o desktop.

## Comandos úteis

```powershell
$env:Path='C:\Users\gusta\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;'+$env:Path
& '.\node_modules\.bin\vinext.cmd' build
```
