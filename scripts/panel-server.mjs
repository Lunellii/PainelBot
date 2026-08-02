import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "../dist/server/index.js";

const root = new URL("../dist/client/", import.meta.url);
const port = Number(process.env.PORT || 3000);
const botEnv = await readFile(process.env.BOT_ENV_PATH || new URL("../bot-service/.env", import.meta.url), "utf8");
const botApiKey = botEnv.match(/^BOT_API_KEY=(.+)$/m)?.[1]?.trim();
if (!botApiKey) throw new Error("BOT_API_KEY não encontrada em bot-service/.env");
const mime = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

async function assetResponse(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
  const safePath = normalize(pathname).replace(/^(\.\.(\\|\/|$))+/, "");
  const fileUrl = new URL(safePath, root);
  try {
    const info = await stat(fileUrl);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    const body = await readFile(fileUrl);
    return new Response(body, { status: 200, headers: { "content-type": mime[extname(safePath)] || "application/octet-stream", "cache-control": safePath.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const target = new URL(url.pathname.slice(4) + url.search, "http://127.0.0.1:3100");
      const apiResponse = await fetch(target, { method: req.method, headers: { authorization: `Bearer ${botApiKey}`, "content-type": req.headers["content-type"] || "application/json" }, body: chunks.length ? Buffer.concat(chunks) : undefined });
      res.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers));
      res.end(Buffer.from(await apiResponse.arrayBuffer()));
      return;
    }
    if (url.pathname.startsWith("/assets/") || /\.(png|svg|woff2|ico)$/.test(url.pathname)) {
      const asset = await assetResponse(new Request(url));
      res.writeHead(asset.status, Object.fromEntries(asset.headers));
      res.end(Buffer.from(await asset.arrayBuffer()));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const context = { waitUntil(promise) { Promise.resolve(promise).catch(() => {}); }, passThroughOnException() {} };
    const response = await worker.fetch(request, { ASSETS: { fetch: assetResponse } }, context);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : "Erro interno");
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Nerdzone Painel em http://127.0.0.1:${port}`));
