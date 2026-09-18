# PainelBot — contexto do projeto

Painel local para gerenciar contas Mineflayer por grupos e proxies fixos. O
painel roda em React 19 + Next 16 servidos pelo `vinext` (Vite 8), o serviço dos
bots é um processo Node separado e o desktop é empacotado com Electron.

## Estrutura

- `app/`: interface do painel. `page.tsx` concentra praticamente toda a UI como
  client component; `layout.tsx`, `globals.css` e `chatgpt-auth.ts` completam.
- `bot-service/src/server.mjs`: serviço HTTP local (`127.0.0.1:3100`) com as
  automações Mineflayer, conexão via proxy e a API consumida pelo painel.
- `electron/main.cjs`: processo principal do desktop. Ele garante que o serviço
  (`3100`) e o painel (`3000`) estejam de pé antes de abrir a janela.
- `scripts/`: iniciadores do Windows (`.ps1`, `.vbs`, `.cs`), o servidor
  estático do painel (`panel-server.mjs`) e o console dos bots
  (`bot-console.mjs`).
- `worker/index.ts`: entrada do Cloudflare Worker usada pelo build e pelo dev.
- `db/` e `drizzle/`: schema Drizzle (SQLite/D1) e migrações geradas.
- `build/sites-vite-plugin.ts`: plugin interno do Vite.
- `tests/`: testes com `node --test`.
- `assets/` e `public/`: ícones e estáticos.
- `dist/`: build gerado; não editar manualmente.

## Regras importantes

- Nunca usar conexão direta como fallback para contas configuradas com proxy.
- Nunca trocar uma conta de proxy ou renomear contas automaticamente.
- Não ler, imprimir ou versionar credenciais e dados privados.
- Arquivos privados ficam em `bot-service/config/`, `.env` e no diretório de
  dados do usuário. Versionar apenas os `*.example.json`.
- Toda rota do serviço exige `BOT_API_KEY`; sem a chave a resposta é `401`.
- Após alterar `app/`, gerar o build antes de testar o desktop: o Electron sobe
  `scripts/panel-server.mjs`, que serve o `dist/` já compilado, e abre
  `http://127.0.0.1:3000`. Sem build novo o desktop mostra a versão antiga.

## Comandos

Instalação (o serviço tem dependências próprias):

```bash
npm install
npm install --prefix bot-service
```

Painel (raiz):

```bash
npm run dev        # vinext dev, painel em http://localhost:3000
npm run build      # vinext build -> dist/
npm run lint       # eslint
npm test           # npm run build + node --test
npm run desktop    # abre o Electron sobre o build atual
npm run db:generate # drizzle-kit generate
```

Serviço dos bots (`bot-service/`, carrega `.env` automaticamente):

```bash
npm start          # serviço em http://127.0.0.1:3100
npm run dev        # mesmo processo com --watch
```

## Estado das verificações

Todas passam hoje; se alguma quebrar, é regressão da sua mudança:

- `npm run build` passa.
- `npm test` passa: roda o build e depois 4 testes em `tests/`. Eles cobrem a
  renderização do painel no servidor, o estado "SEM API" quando o serviço não
  está no ar, a ausência de restos do template `site-creator-vinext-starter` e
  a regra de não versionar `accounts.json`, `proxies.json`, `server.json` nem
  `.env`.
- `npm run lint` passa sem erros. Resta 1 aviso conhecido:
  `purchaseAndDeliver` em `bot-service/src/server.mjs:884` está definido e
  nunca chamado. É lógica de compra no mercado; foi deixada de propósito para
  alguém decidir se liga ou remove.
- `npx tsc --noEmit` acusa tipos do Cloudflare Workers ausentes
  (`cloudflare:workers`, `D1Database`, `Fetcher`). A configuração do Cloudflare
  mora dentro de `vite.config.ts`, não há arquivo do Wrangler e portanto
  `wrangler types` não roda. O build é a verificação de tipos efetiva.

O GitHub Actions roda lint, build e testes a cada push e pull request
(`.github/workflows/ci.yml`).

## Ambiente

O projeto é usado no Windows 10/11 com Node 22+, mas o código não depende disso
fora de `scripts/` e do empacotamento Electron. Sessões de agente em Linux
conseguem instalar, buildar, lintar e subir o `bot-service`; o que não dá para
validar fora do Windows é o Electron empacotado e os iniciadores `.bat`/`.cmd`.
