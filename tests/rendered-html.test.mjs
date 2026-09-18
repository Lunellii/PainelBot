import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);

// O painel é renderizado pelo worker que o `vinext build` gera em dist/.
// `npm test` roda o build antes, então dist/ reflete o código atual.
async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renderiza o painel no servidor", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();

  assert.match(html, /<html lang="pt-BR">/);
  assert.match(html, /<title>Nerdzone Bot Manager<\/title>/i);
  assert.match(html, /name="description" content="Central para gerenciar contas/);

  // A casca do painel precisa vir pronta do servidor, e não só depois da
  // hidratação: é ela que o Electron mostra enquanto o JS carrega.
  assert.match(html, /class="app-shell"/);
  assert.match(html, /class="sidebar"/);
  assert.match(html, /<h1>Controle seus <em>bots<\/em><\/h1>/);
  assert.match(html, /Minecraft 1\.8\.9/);
});

test("sem serviço no ar, o painel mostra o estado desconectado", async () => {
  const html = await (await render()).text();

  // Durante o build não há bot-service escutando em 3100, então o painel tem
  // de indicar isso em vez de fingir que está conectado.
  assert.match(html, /SEM API/);
  assert.match(html, /Desconectado/);
  assert.doesNotMatch(html, /AO VIVO/);
});

test("nao sobrou nada do template site-creator", async () => {
  const html = await (await render()).text();

  assert.doesNotMatch(html, /react-loading-skeleton/);
  assert.doesNotMatch(html, /Your site is taking shape/i);
  assert.doesNotMatch(html, /codex-preview/i);
  assert.doesNotMatch(html, /Starter Project/i);
});

test("credenciais e proxies reais nao entram no Git", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  // A regra mais importante do projeto: só os .example.json são versionados.
  for (const privado of [
    "bot-service/config/accounts.json",
    "bot-service/config/proxies.json",
    "bot-service/config/server.json",
  ]) {
    assert.ok(!tracked.includes(privado), `${privado} nao pode estar versionado`);
  }

  for (const exemplo of [
    "bot-service/config/accounts.example.json",
    "bot-service/config/proxies.example.json",
  ]) {
    assert.ok(tracked.includes(exemplo), `${exemplo} deveria estar versionado`);
  }

  assert.ok(
    !tracked.some((file) => file === ".env" || file.startsWith(".env.")),
    "nenhum .env pode estar versionado",
  );
});
