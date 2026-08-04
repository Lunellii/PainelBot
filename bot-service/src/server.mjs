import { createServer } from "node:http";
import net from "node:net";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mineflayer from "mineflayer";
import { SocksClient } from "socks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const configRoot = env.BOT_CONFIG_DIR ? resolve(env.BOT_CONFIG_DIR) : resolve(root, "config");
const port = Number(env.PORT || 3100);
const apiKey = env.BOT_API_KEY || "";
const origin = env.PANEL_ORIGIN || "http://localhost:3000";
const defaultServer = {
  host: env.MINECRAFT_HOST || "jogar.nerdzone.gg",
  port: Number(env.MINECRAFT_PORT || 30000),
  version: env.MINECRAFT_VERSION || "1.8.9",
  loginCommand: env.LOGIN_COMMAND || "/logar",
  plotCommand: env.PLOT_COMMAND || "/plot h vulks_ 2",
  fishCommand: env.FISH_COMMAND || "/pescar",
  marketCommand: env.MARKET_COMMAND || "/mercado",
  balanceCommand: env.BALANCE_COMMAND || "/peixes",
};
const maxPerProxy = Number(env.MAX_ACCOUNTS_PER_PROXY || 10);
const proxyConnectTimeout = Number(env.PROXY_CONNECT_TIMEOUT || 15000);
const maxProxyHandshakes = Number(env.MAX_PROXY_HANDSHAKES || 2);
const kitDeliveryTimeout = Number(env.KIT_DELIVERY_TIMEOUT || 12000);
const ghostSessionWait = Number(env.GHOST_SESSION_WAIT || 45000);
const sequentialDelay = Number(env.SEQUENTIAL_DELAY || 5000);
// Os bots ficam parados pescando num ponto fixo: carregar os chunks ao redor
// só consome RAM e CPU da única thread do Node.
const viewDistance = env.BOT_VIEW_DISTANCE || "tiny";
const physicsEnabled = env.BOT_PHYSICS !== "false";
const bots = new Map();
const accountAutomations = new Map();
let accountWriteQueue = Promise.resolve();
const groupAutomation = { running: false, runId: 0, startedAt: null, currentGroup: null, currentAccounts: [], completedGroups: [], failedAccounts: [], nextGroupAt: null, message: "Parado" };
const protectedItems = new Set(["glass_bottle", "slime", "slime_block", "shears", "compass", "clock", "nether_star"]);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// Cada proxy aceita poucas conexões simultâneas; abrir dez handshakes de uma vez
// faz o SOCKS estourar o tempo limite em vez de recusar.
const proxyGates = new Map();

function throughProxyGate(proxyId, task) {
  const gate = proxyGates.get(proxyId) || { active: 0, queue: [] };
  proxyGates.set(proxyId, gate);
  return new Promise((settle, fail) => {
    const run = () => {
      gate.active += 1;
      task().then(settle, fail).finally(() => {
        gate.active -= 1;
        const next = gate.queue.shift();
        if (next) next();
      });
    };
    if (gate.active < maxProxyHandshakes) run();
    else gate.queue.push(run);
  });
}

// O motivo do kick chega como componente de chat JSON; sem converter, o painel
// mostra a estrutura crua no lugar da mensagem.
function decodeChatComponent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(decodeChatComponent).join("");
  if (!value || typeof value !== "object") return String(value ?? "");
  return [value.text || "", ...(Array.isArray(value.extra) ? value.extra : []).map(decodeChatComponent)].join("");
}

function plainText(raw) {
  if (typeof raw !== "string") return decodeChatComponent(raw);
  const text = raw.trim();
  if (!/^[{["]/.test(text)) return raw;
  // Alguns servidores mandam quebra de linha crua dentro do JSON, o que quebra o
  // JSON.parse; a segunda tentativa escapa os caracteres de controle.
  const escaped = text.replace(/[\u0000-\u001F]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  for (const candidate of [text, escaped]) {
    try { return decodeChatComponent(JSON.parse(candidate)); } catch { /* tenta o próximo formato */ }
  }
  return raw;
}

// As proxies da Webshare atendem em HTTP CONNECT, não em SOCKS5. Mantemos os
// dois: `protocol: "socks5"` na proxy força o antigo.
function connectViaHttpProxy(proxy, destination, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: Number(proxy.port) });
    let resolved = false;
    const fail = (error) => { if (resolved) return; resolved = true; socket.destroy(); reject(error); };
    socket.setTimeout(timeout, () => fail(new Error("Proxy connection timed out")));
    socket.once("error", fail);
    socket.once("connect", () => {
      const head = [`CONNECT ${destination.host}:${destination.port} HTTP/1.1`, `Host: ${destination.host}:${destination.port}`];
      if (proxy.username) head.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64")}`);
      socket.write(`${head.join("\r\n")}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      const corte = chunk.indexOf("\r\n\r\n");
      const cabecalho = (corte >= 0 ? chunk.slice(0, corte) : chunk).toString("utf8");
      const status = cabecalho.split("\r\n")[0] || "";
      if (!/^HTTP\/1\.[01] 200/.test(status)) return fail(new Error(`Proxy recusou o túnel: ${status.slice(0, 80) || "resposta vazia"}`));
      // O que veio depois do cabeçalho já é do servidor: devolve para o stream.
      if (corte >= 0 && chunk.length > corte + 4) socket.unshift(chunk.slice(corte + 4));
      resolved = true;
      socket.setTimeout(0);
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}

function openProxyTunnel(proxy, destination, timeout) {
  const protocolo = String(proxy.protocol || env.PROXY_PROTOCOL || "http").toLowerCase();
  if (protocolo === "socks5" || protocolo === "socks") {
    return SocksClient.createConnection({
      proxy: { host: proxy.host, port: Number(proxy.port), type: 5, userId: proxy.username || undefined, password: proxy.password || undefined },
      command: "connect", destination, timeout,
    }).then(({ socket }) => socket);
  }
  return connectViaHttpProxy(proxy, destination, timeout);
}

async function waitForItem(bot, predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = bot.inventory.items().find(predicate);
    if (found) return found;
    await sleep(400);
  }
  return null;
}

function itemAmount(bot, item) {
  return bot.inventory.items().filter((entry) => entry.type === item.type && entry.metadata === item.metadata).reduce((sum, entry) => sum + entry.count, 0);
}

async function tossStackVerified(bot, item) {
  const before = itemAmount(bot, item);
  const expectedAfter = Math.max(0, before - item.count);
  // O servidor exige dois drops rápidos e pode perder a confirmação sob carga.
  for (let round = 0; round < 4; round += 1) {
    if (itemAmount(bot, item) <= expectedAfter) return;
    const current = bot.inventory.items().find((entry) => entry.type === item.type && entry.metadata === item.metadata);
    if (!current) return;
    bot.clickWindow(current.slot, 1, 4).catch(() => {});
    await sleep(140);
    bot.clickWindow(current.slot, 1, 4).catch(() => {});
    await sleep(700);
  }
  if (itemAmount(bot, item) > expectedAfter) throw new Error(`O servidor não removeu ${item.displayName || item.name} após quatro rodadas de confirmação.`);
}

if (!apiKey) throw new Error("Defina BOT_API_KEY antes de iniciar o serviço.");

// writeFile trunca o arquivo antes de gravar: uma queda nessa janela apagaria
// todas as contas. Grava num temporário e troca por rename, que é atômico.
async function writeJsonAtomic(name, data) {
  const target = resolve(configRoot, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
  // No Windows o rename falha enquanto alguém mantém o arquivo aberto para
  // leitura, e o painel consulta a lista a cada 1,5s.
  for (let attempt = 1; ; attempt += 1) {
    try { return await rename(temporary, target); }
    catch (error) {
      if (attempt >= 25 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      await sleep(120);
    }
  }
}

// Toda gravação de contas passa por esta fila: duas gravações concorrentes
// liam a lista antes e uma sobrescrevia a outra, perdendo contas inteiras.
function appendAccounts(created) {
  const run = accountWriteQueue.then(async () => {
    const current = await loadAccounts();
    const nicks = new Set(current.map((entry) => entry.username.toLowerCase()));
    const duplicated = created.find((entry) => nicks.has(entry.username.toLowerCase()));
    if (duplicated) throw new Error(`A conta ${duplicated.username} já existe`);
    const merged = [...current, ...created];
    await writeJsonAtomic("accounts.json", merged);
    return merged;
  });
  accountWriteQueue = run.catch(() => {});
  return run;
}

// A lista é relida a cada requisição do painel; com centenas de contas o
// parse do arquivo inteiro a cada 1,5s pesa à toa. Recarrega só quando muda.
let accountsCache = { key: "", data: null };

async function loadAccounts() {
  const file = resolve(configRoot, "accounts.json");
  const info = await stat(file);
  const key = `${info.mtimeMs}:${info.size}`;
  if (accountsCache.data && accountsCache.key === key) return accountsCache.data;
  const accounts = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(accounts) || accounts.length < 1) throw new Error("accounts.json deve conter pelo menos uma conta.");
  accountsCache = { key, data: accounts };
  return accounts;
}

function markAccountRegistered(account) {
  if (account.registered === true) return;
  account.registered = true;
  accountWriteQueue = accountWriteQueue.then(async () => {
    const accounts = await loadAccounts();
    const saved = accounts.map((entry) => entry.id === account.id ? { ...entry, registered: true } : entry);
    await writeJsonAtomic("accounts.json", saved);
  }).catch((error) => console.error(`[${account.username}] falha ao salvar registro: ${error.message}`));
}

function saveAccountBalance(account, balance, updatedAt) {
  const previousBalance = Number(account.fishBalance) || 0;
  const previousUpdatedAt = Date.parse(account.balanceUpdatedAt || "") || 0;
  account.fishBalance = balance;
  account.balanceUpdatedAt = updatedAt;
  if (previousBalance === balance && Date.now() - previousUpdatedAt < 300000) return;
  accountWriteQueue = accountWriteQueue.then(async () => {
    const accounts = await loadAccounts();
    const saved = accounts.map((entry) => entry.id === account.id ? { ...entry, fishBalance: balance, balanceUpdatedAt: updatedAt } : entry);
    await writeJsonAtomic("accounts.json", saved);
  }).catch((error) => console.error(`[${account.username}] falha ao salvar saldo: ${error.message}`));
}

async function loadProxies() {
  try {
    const proxies = JSON.parse(await readFile(resolve(configRoot, "proxies.json"), "utf8"));
    return Array.isArray(proxies) ? proxies : [];
  } catch { return []; }
}

async function loadServerConfig() {
  try { return { ...defaultServer, ...JSON.parse(await readFile(resolve(configRoot, "server.json"), "utf8")) }; }
  catch { return { ...defaultServer }; }
}

function inventoryOf(bot) {
  if (!bot?.inventory) return [];
  const grouped = new Map();
  for (const item of bot.inventory.items()) {
    const key = `${item.name}:${item.metadata ?? 0}`;
    const current = grouped.get(key) || { name: item.name, displayName: item.displayName || item.name, count: 0, metadata: item.metadata ?? 0, hotbarSlots: [], outsideHotbar: false };
    current.count += item.count;
    if (item.slot >= 36 && item.slot <= 44) {
      const hotbarSlot = item.slot - 35;
      if (!current.hotbarSlots.includes(hotbarSlot)) current.hotbarSlots.push(hotbarSlot);
    } else {
      current.outsideHotbar = true;
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count);
}

function parseAmount(raw) {
  const clean = String(raw).trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const match = clean.match(/^([\d.]+)([kKmM])?$/);
  if (!match) return null;
  const multiplier = match[2]?.toLowerCase() === "k" ? 1000 : match[2]?.toLowerCase() === "m" ? 1000000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function queryBalance(state, bot, serverConfig) {
  if (!bot || state.status !== "online") return;
  if (state.balancePending && Date.now() - state.balanceRequestedAt < 15000) return;
  state.balanceRequestedAt = Date.now();
  state.balancePending = true;
  state.balanceError = null;
  bot.chat(serverConfig.balanceCommand);
  if (state.balanceTimeout) clearTimeout(state.balanceTimeout);
  state.balanceTimeout = setTimeout(() => {
    if (state.balancePending) {
      state.balancePending = false;
      state.balanceError = "O servidor não respondeu ao /peixes.";
    }
  }, 20000);
}

function parseBalanceReply(message) {
  const text = String(message || "").replace(/§[0-9A-FK-OR]/gi, "").replace(/\s+/g, " ").trim();
  if (!text || /^\+\s*\d/i.test(text) || /^\[G\]/i.test(text)) return null;
  const patterns = [
    /(?:saldo|possui|tem)[^\d]{0,30}([\d.,]+\s*[kKmM]?)\s*peixes?/i,
    /([\d.,]+\s*[kKmM]?)\s*peixes?/i,
    /peixes?\s*[:\-]?\s*([\d.,]+\s*[kKmM]?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = parseAmount(match[1]);
      if (value !== null) return value;
    }
  }
  return null;
}

function marketOf(state) {
  const window = state?.bot?.currentWindow;
  if (!window || !/mercado|pesca/i.test(window.title || "")) return state?.market || [];
  const limit = Number.isInteger(window.inventoryStart) ? window.inventoryStart : Math.max(0, window.slots.length - 36);
  return window.slots.slice(0, limit).map((item, slot) => item ? {
    slot,
    name: item.name,
    displayName: item.displayName || item.name,
    count: item.count,
    lore: Array.isArray(item.customLore) ? item.customLore.map(String) : [],
  } : null).filter(Boolean);
}

// A lista do painel é consultada a cada 1,5s; inventário, mercado e chat só são
// serializados quando a conta está aberta em detalhe.
function publicState(account, { detailed = false } = {}) {
  const state = bots.get(account.id);
  const items = state?.bot?.inventory ? state.bot.inventory.items() : [];
  return {
    itemCount: items.reduce((sum, item) => sum + item.count, 0),
    id: account.id,
    username: account.username,
    status: state?.status || "offline",
    activity: state?.activity || "parado",
    location: state?.location || (state?.rankupReady ? "rankup" : "lobby"),
    fishCount: state?.fishBalance ?? account.fishBalance ?? 0,
    fishPerMinute: state?.status === "online" ? Number(state.fishPerMinute) || 0 : 0,
    fishPerHour: state?.status === "online" ? (Number(state.fishPerMinute) || 0) * 60 : 0,
    balanceUpdatedAt: state?.balanceUpdatedAt || account.balanceUpdatedAt || null,
    inventory: detailed ? inventoryOf(state?.bot) : [],
    market: detailed ? marketOf(state) : [],
    lastMessage: state?.lastMessage || null,
    lastMessageAt: state?.lastMessageAt || null,
    chatMessages: detailed ? state?.messages || [] : [],
    lastError: state?.lastError || null,
    purchaseNotice: state?.purchaseNotice || null,
    connectedAt: state?.connectedAt || null,
    automationRunning: state?.automationRunning || false,
    blocked: state?.blocked || false,
    blockedReason: state?.blockedReason || null,
    registered: account.registered === true,
    balancePending: state?.balancePending || false,
    balanceError: state?.balanceError || null,
    balanceStatus: state?.balancePending ? "atualizando" : state?.balanceError ? "erro" : state?.balanceUpdatedAt || account.balanceUpdatedAt ? (Date.now() - Date.parse(state?.balanceUpdatedAt || account.balanceUpdatedAt) > 180000 ? "desatualizado" : "atualizado") : "sem_dados",
    proxyId: account.proxyId || null,
    position: state?.bot?.entity?.position ? {
      x: Math.round(state.bot.entity.position.x * 10) / 10,
      y: Math.round(state.bot.entity.position.y * 10) / 10,
      z: Math.round(state.bot.entity.position.z * 10) / 10,
    } : null,
  };
}

// Recusa antes de existir estado ficava invisível no painel: a conta aparecia
// como "parado", sem erro nenhum.
function registrarFalha(account, mensagem) {
  const state = bots.get(account.id) || { messages: [], market: [] };
  if (!state.bot) { state.status = "offline"; state.location = "offline"; state.activity = "recusado"; }
  state.lastError = mensagem;
  bots.set(account.id, state);
  console.error(`[${account.username}] ${mensagem}`);
  const erro = new Error(mensagem);
  erro.configuracao = true; // erro de cadastro: repetir não resolve
  return erro;
}

async function connect(account) {
  const current = bots.get(account.id);
  if (current?.bot) return publicState(account);
  // Só quem foi marcado explicitamente com allowLocal usa a conexão direta.
  // Conta com proxyId nunca cai para o IP da máquina, mesmo com o proxy fora.
  const allowedLocalAccount = account.allowLocal === true;
  if (!account.proxyId && !allowedLocalAccount) throw registrarFalha(account, `Conexão local bloqueada para ${account.username}. Marque allowLocal na conta ou defina um proxy.`);
  // Reconectar recria o estado; sem herdar estes campos a automação em curso
  // aparece como parada e a marca de bloqueio do servidor se perde no retry.
  const state = { bot: null, status: "conectando", activity: "conectando", location: "lobby", registrationBlocked: false, intentionalDisconnect: false, fishing: false, automationRunning: current?.automationRunning || false, automationPromise: current?.automationPromise || null, blocked: current?.blocked || false, blockedReason: current?.blockedReason || null, rankupReady: false, fishBalance: Number(account.fishBalance) || 0, fishPerMinute: 0, balanceUpdatedAt: account.balanceUpdatedAt || null, balanceRequestedAt: 0, balancePending: false, balanceTimeout: null, balanceRefreshTimer: null, balanceError: null, market: [], messages: [], balanceTimer: null, authTimer: null, authenticated: false, lastError: null, lastMessage: null, lastMessageAt: null, connectedAt: null, authAttempts: 0, lastAuthAt: 0, joinTimer: null, kitNotice: null, kitBlocked: false, kitRequestedAt: 0 };
  bots.set(account.id, state);
  const serverConfig = await loadServerConfig();
  const options = { host: serverConfig.host, port: serverConfig.port, version: serverConfig.version, username: account.username, auth: account.auth || "offline", hideErrors: true, viewDistance, physicsEnabled };
  if (account.proxyId) {
    const proxy = (await loadProxies()).find((item) => item.id === account.proxyId);
    if (!proxy) throw registrarFalha(account, `Proxy "${account.proxyId}" não está cadastrada. Recadastre-a ou troque a proxy de ${account.username}.`);
    options.connect = (client) => {
      throughProxyGate(proxy.id, () => openProxyTunnel(proxy, { host: serverConfig.host, port: serverConfig.port }, proxyConnectTimeout))
        // A conta pode ter desistido enquanto o handshake esperava na fila; sem
        // isto o socket órfão continuaria ocupando uma vaga do proxy.
        .then((socket) => { if (!state.bot) return socket.destroy(); client.setSocket(socket); client.emit("connect"); })
        .catch((error) => { state.lastError = `Proxy ${proxy.id}: ${error.message}`; state.status = "offline"; state.activity = "parado"; state.location = "offline"; state.bot = null; client.emit("error", error); client.end(); });
    };
  }
  const bot = mineflayer.createBot(options);
  state.bot = bot;
  bot.once("spawn", () => {
    state.status = "online";
    state.activity = "parado";
    state.location = "lobby";
    state.connectedAt = new Date().toISOString();
    state.lastError = null;
    console.log(`[${account.username}] entrou no servidor`);
    const authenticate = () => {
      if (state.authenticated || state.registrationBlocked || state.status !== "online" || state.bot !== bot) return;
      if (!account.serverPassword) return;
      state.lastAuthAt = Date.now();
      state.authAttempts += 1;
      if (account.registered === false) {
        state.activity = "registrando";
        bot.chat(`/registrar ${account.serverPassword} ${account.serverPassword}`);
        console.log(`[${account.username}] comando de registro enviado`);
      } else if (serverConfig.loginCommand) {
        state.activity = "autenticando";
        const alternateLogin = serverConfig.loginCommand === "/logar" ? "/login" : "/logar";
        const loginCommand = state.authAttempts % 2 === 0 ? alternateLogin : serverConfig.loginCommand;
        bot.chat(`${loginCommand} ${account.serverPassword}`);
        console.log(`[${account.username}] comando de login enviado`);
      }
      if (state.authAttempts < 4) state.authTimer = setTimeout(authenticate, 6000);
      else state.lastError = "O servidor não confirmou o login/registro após 4 tentativas.";
    };
    state.authTimer = setTimeout(authenticate, 1200);
  });
  bot.on("messagestr", (message) => {
    state.lastMessage = String(message).replace(account.serverPassword || "__sem_senha__", "********").slice(-300);
    state.lastMessageAt = new Date().toISOString();
    state.messages.push({ at: state.lastMessageAt, text: state.lastMessage, direction: "in" });
    if (state.messages.length > 30) state.messages.splice(0, state.messages.length - 30);
    console.log(`[${account.username}] ${state.lastMessage}`);
    if (/limites? de contas por ip|limite de contas por ip|esgotou os limites/i.test(state.lastMessage)) {
      state.registrationBlocked = true;
      state.lastError = "Registro bloqueado: o servidor atingiu o limite de contas por IP nesta proxy.";
      state.activity = "registro bloqueado por limite de IP";
      if (state.authTimer) clearTimeout(state.authTimer);
    }
    // Só interpreta como resposta ao /kit dentro da janela do comando: o chat
    // global traz mensagens de outros jogadores que casariam com estes padrões.
    const awaitingKit = state.kitRequestedAt && Date.now() - state.kitRequestedAt < 15000 && !/^\[G\]/i.test(state.lastMessage);
    if (awaitingKit && /kit/i.test(state.lastMessage) && /aguarde|espere|dispon[ií]vel em|cooldown|j[aá] (?:pegou|resgatou|usou|utilizou)|somente.*(?:hora|dia)/i.test(state.lastMessage)) {
      state.kitNotice = `Kit indisponível: ${state.lastMessage}`;
      state.kitBlocked = true;
    }
    if (awaitingKit && /invent[aá]rio.*(?:cheio|lotado)|libere.*espa[cç]o/i.test(state.lastMessage)) {
      state.kitNotice = `Inventário cheio: ${state.lastMessage}`;
    }
    const recentBalanceRequest = state.balancePending && Date.now() - state.balanceRequestedAt < 20000;
    const balance = recentBalanceRequest ? parseBalanceReply(state.lastMessage) : null;
    if (balance !== null) {
      const previousBalance = Number(state.fishBalance) || 0;
      const previousAt = Date.parse(state.balanceUpdatedAt || "");
      const now = Date.now();
      const connectedAt = Date.parse(state.connectedAt || "");
      if (previousAt && (!connectedAt || previousAt >= connectedAt) && now > previousAt && balance >= previousBalance) {
        const elapsedMinutes = (now - previousAt) / 60000;
        if (elapsedMinutes >= 0.25) state.fishPerMinute = (balance - previousBalance) / elapsedMinutes;
      }
      state.fishBalance = balance;
      state.balanceUpdatedAt = new Date(now).toISOString();
      state.balanceRequestedAt = 0;
      state.balancePending = false;
      state.balanceError = null;
      if (state.balanceTimeout) clearTimeout(state.balanceTimeout);
      saveAccountBalance(account, balance, state.balanceUpdatedAt);
    }
    if (/^\+\s*[\d.,]+\s*peixes?/i.test(state.lastMessage) && !state.balanceRefreshTimer && Date.now() - state.balanceRequestedAt > 15000) {
      state.balanceRefreshTimer = setTimeout(() => { state.balanceRefreshTimer = null; queryBalance(state, bot, serverConfig); }, 5000);
    }
    if (account.registered === false && /registrad[oa].*sucesso|registro.*sucesso|autenticad[oa].*sucesso/i.test(state.lastMessage)) {
      markAccountRegistered(account);
      state.authenticated = true;
      state.activity = "autenticado";
      if (state.authTimer) clearTimeout(state.authTimer);
      if (state.joinTimer) clearTimeout(state.joinTimer);
      state.joinTimer = setTimeout(() => joinRankup(account, state), 3500);
    }
    if (account.registered === false && /j[aá].*registrad|utilize.*\/(?:logar|login)|use.*\/(?:logar|login)/i.test(state.lastMessage)) {
      markAccountRegistered(account);
      bot.chat(`${serverConfig.loginCommand} ${account.serverPassword}`);
    }
    if (account.registered !== false && /logou com sucesso|login (?:efetuado|realizado).*sucesso|autenticad[oa].*sucesso/i.test(state.lastMessage)) {
      state.authenticated = true;
      state.activity = "autenticado";
      if (state.authTimer) clearTimeout(state.authTimer);
      if (state.joinTimer) clearTimeout(state.joinTimer);
      state.joinTimer = setTimeout(() => joinRankup(account, state), 1800);
    }
    if (/Enviando voce para RankUP Futury agora|selecion(e|ou).*rankup|rankup.*entrou/i.test(state.lastMessage)) {
      state.activity = "entrando no RankUP";
      state.location = "rankup";
    }
  });
  bot.on("windowOpen", (window) => {
    setTimeout(() => { state.market = marketOf(state); console.log(`[${account.username}] menu aberto: ${window.title} (${state.market.length} itens)`); }, 300);
  });
  bot.on("kicked", (reason) => {
    const text = plainText(reason).replace(/§[0-9A-FK-OR]/gi, "").replace(/\s+/g, " ").trim();
    state.lastError = `Expulso: ${text.slice(0, 300)}`;
    // O servidor recusou a sessão; insistir só queima o proxy e repete o kick.
    if (/anti-?bot|bot detectado|uso de bot/i.test(text)) {
      state.blocked = true;
      state.blockedReason = text.slice(0, 200);
      state.activity = "bloqueado pelo servidor";
    }
    console.error(`[${account.username}] ${state.lastError}`);
  });
  // Não sobrescreve um erro já registrado com mais contexto (ex.: qual proxy falhou).
  bot.on("error", (error) => { if (!state.lastError?.includes(error.message)) state.lastError = error.message; console.error(`[${account.username}] ${error.message}`); });
  bot.once("end", (reason) => { if (state.balanceTimer) clearInterval(state.balanceTimer); if (state.balanceTimeout) clearTimeout(state.balanceTimeout); if (state.balanceRefreshTimer) clearTimeout(state.balanceRefreshTimer); if (state.authTimer) clearTimeout(state.authTimer); if (state.joinTimer) clearTimeout(state.joinTimer); const endText = plainText(reason || "").replace(/§[0-9A-FK-OR]/gi, "").replace(/\s+/g, " ").trim(); const expectedEnd = state.intentionalDisconnect || /Desconectado pelo painel|Repetindo fluxo automático/i.test(endText); if (/anti-?bot|bot detectado|uso de bot/i.test(endText)) { state.blocked = true; state.blockedReason = endText.slice(0, 200); } if (expectedEnd) state.lastError = null; else if (!state.lastError && endText) state.lastError = `Conexão encerrada: ${endText.slice(0, 200)}`; state.bot = null; state.status = "offline"; state.activity = state.blocked ? "bloqueado pelo servidor" : "parado"; state.location = "offline"; state.fishing = false; state.rankupReady = false; state.balancePending = false; console.log(`[${account.username}] desconectou`); });
  return publicState(account);
}

async function waitForWindow(bot, timeout = 6000) {
  if (bot.currentWindow) return bot.currentWindow;
  return Promise.race([
    new Promise((resolveWindow) => bot.once("windowOpen", resolveWindow)),
    sleep(timeout).then(() => { throw new Error("O menu da bússola não abriu."); }),
  ]);
}

async function putRodInFirstHotbarSlot(bot, rod) {
  if (rod.slot === 36) {
    bot.setQuickBarSlot(0);
    return;
  }
  try {
    // Mode 2 + botão 0 equivale à tecla numérica 1: troca o item com o primeiro slot da hotbar em um único pacote.
    await bot.clickWindow(rod.slot, 0, 2);
  } catch (error) {
    if (!/didn.t respond to transaction/i.test(String(error?.message || error))) throw error;
    console.warn("O servidor não confirmou a troca da vara, mas o pacote de atalho foi enviado.");
  }
  await sleep(500);
  bot.setQuickBarSlot(0);
}

function rodMultiplier(item) {
  const text = `${item?.displayName || ""} ${JSON.stringify(item?.nbt || {})}`;
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*x/i);
  return match ? Number(match[1].replace(",", ".")) : 1;
}

function rodSignature(item) {
  return `${rodMultiplier(item)}|${item?.displayName || item?.name || "fishing_rod"}`;
}

async function moveInventoryToTrash(bot, state, keepRodSignature = null) {
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  await sleep(200);
  bot.chat("/lixeira");
  const window = await waitForWindow(bot, 6000);
  if (!Number.isInteger(window.inventoryStart)) throw new Error("A /lixeira não abriu um inventário válido.");
  let keptRod = false;
  const items = bot.inventory.items().filter((item) => {
    if (item.name !== "fishing_rod") return true;
    if (!keptRod && keepRodSignature && rodSignature(item) === keepRodSignature) {
      keptRod = true;
      return false;
    }
    return true;
  });
  for (const item of items) {
    if (item.slot < 9 || item.slot > 44) continue;
    const windowSlot = window.inventoryStart + item.slot - 9;
    if (!window.slots[windowSlot]) continue;
    const before = itemAmount(bot, item);
    bot.clickWindow(windowSlot, 0, 1).catch(() => {});
    await sleep(180);
    if (itemAmount(bot, item) >= before) {
      bot.clickWindow(windowSlot, 0, 1).catch(() => {});
      await sleep(350);
    }
  }
  await sleep(500);
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  state.activity = "verificando inventário";
  await sleep(400);
}

async function runStarterKit(account, state) {
  const bot = state.bot;
  if (!bot || state.status !== "online") return;
  state.lastError = null;
  state.kitNotice = null;
  // Sem espaço livre o kit cai no chão e o bot conclui que nada foi entregue.
  if (bot.inventory.items().length >= 34) {
    state.activity = "liberando espaço antes do kit";
    await moveInventoryToTrash(bot, state);
  }
  state.activity = "pegando kit iniciante";
  state.kitRequestedAt = Date.now();
  bot.chat("/kit iniciante");
  // Sob carga o servidor demora bem mais que os 3,5s que a rotina esperava.
  await waitForItem(bot, (item) => item.name === "fishing_rod", kitDeliveryTimeout);

  let rod = bot.inventory.items().filter((item) => item.name === "fishing_rod").sort((a, b) => rodMultiplier(b) - rodMultiplier(a))[0];
  if (!rod) throw new Error(state.kitNotice || "O /kit iniciante não entregou uma vara de pesca.");
  const firstHotbarSlot = 36;
  if (rod.slot !== firstHotbarSlot) {
    state.activity = "movendo vara para o slot 1";
    await putRodInFirstHotbarSlot(bot, rod);
  }

  rod = bot.inventory.items().filter((item) => item.name === "fishing_rod").sort((a, b) => rodMultiplier(b) - rodMultiplier(a))[0];
  const keepRod = rodSignature(rod);
  if (!rod) throw new Error("A vara desapareceu durante a organização do inventário.");
  bot.setQuickBarSlot(0);

  for (let pass = 0; pass < 3; pass += 1) {
    const rods = bot.inventory.items().filter((item) => item.name === "fishing_rod");
    const kept = rods.find((item) => rodSignature(item) === keepRod) || rods[0];
    const leftovers = bot.inventory.items().filter((item) => item.name !== "fishing_rod").concat(rods.filter((item) => item !== kept));
    if (!leftovers.length) break;
    state.activity = `limpando inventário na /lixeira (${pass + 1}/3)`;
    await moveInventoryToTrash(bot, state, keepRod);
  }
  const rods = bot.inventory.items().filter((item) => item.name === "fishing_rod");
  const kept = rods.find((item) => rodSignature(item) === keepRod) || rods[0];
  const leftovers = bot.inventory.items().filter((item) => item.name !== "fishing_rod").concat(rods.filter((item) => item !== kept));
  rod = kept;
  if (!rod) throw new Error("A vara desapareceu durante a limpeza na /lixeira.");
  if (rod.slot !== firstHotbarSlot) await putRodInFirstHotbarSlot(bot, rod);
  bot.setQuickBarSlot(0);
  if (leftovers.length) throw new Error(`A /lixeira não removeu: ${leftovers.map((item) => item.displayName || item.name).join(", ")}`);
  state.activity = "aguardando comandos";
  console.log(`[${account.username}] kit preparado: somente a vara permaneceu no slot 1`);
}

// Se a conta caiu, o kit nem chegou a rodar: culpar o kit esconde a causa real.
function exigirOnline(state, etapa) {
  if (state.bot && state.status === "online") return;
  throw new Error(state.lastError || `A conta desconectou antes de ${etapa}.`);
}

async function runStarterKitWithRetry(account, state, attempts = 3) {
  let lastError = null;
  state.kitBlocked = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      exigirOnline(state, "pegar o kit iniciante");
      await runStarterKit(account, state);
      exigirOnline(state, "concluir o kit iniciante");
      if (state.bot?.inventory.items().some((item) => item.name === "fishing_rod")) return;
      throw new Error(state.kitNotice || "O kit terminou sem uma vara de pesca.");
    } catch (error) {
      lastError = error;
      if (!state.bot || state.status !== "online") throw error;
      if (state.kitBlocked) throw new Error(state.kitNotice || "O kit iniciante está em cooldown para esta conta.");
      if (attempt < attempts && state.bot && state.status === "online") {
        state.lastError = `Kit sem vara; repetindo (${attempt + 1}/${attempts})`;
        state.activity = "repetindo kit iniciante";
        await sleep(2500);
      }
    }
  }
  throw lastError || new Error("O /kit iniciante falhou.");
}

async function joinRankup(account, state, attempt = 0) {
  const bot = state.bot;
  if (!bot || state.status !== "online") return;
  let selectedRankup = false;
  state.activity = "abrindo RankUP";
  state.lastError = null;
  try {
    const compass = bot.inventory.items().find((item) => item.name === "compass");
    if (!compass) throw new Error("A bússola do seletor de servidores ainda não apareceu.");
    await bot.equip(compass, "hand");
    await sleep(350);
    bot.activateItem();
    const window = await waitForWindow(bot);
    const rankupSlot = 13;
    if (!window.slots[rankupSlot]) throw new Error("Item RankUP não encontrado no slot esperado (coluna 5, linha 2)." );
    await bot.clickWindow(rankupSlot, 0, 0);
    selectedRankup = true;
    state.activity = "entrando no RankUP";
    console.log(`[${account.username}] RankUP selecionado no slot ${rankupSlot}`);
    await sleep(8000);
    // Permanece parado no spawn depois de entrar no RankUP, aguardando o painel.
    bot.deactivateItem();
    bot.clearControlStates();
    if (typeof bot.stopDigging === "function") bot.stopDigging();
    state.rankupReady = true;
    state.location = "rankup";
    state.activity = "aguardando comandos";
    const serverConfig = await loadServerConfig();
    queryBalance(state, bot, serverConfig);
    if (state.balanceTimer) clearInterval(state.balanceTimer);
    state.balanceTimer = setInterval(() => queryBalance(state, bot, serverConfig), 60000);
  } catch (error) {
    state.activity = selectedRankup ? "RankUP" : "lobby";
    state.lastError = error instanceof Error ? error.message : "Falha ao entrar no RankUP";
    console.error(`[${account.username}] ${state.lastError}`);
    if (!selectedRankup && attempt < 2 && state.bot === bot && state.status === "online") state.joinTimer = setTimeout(() => joinRankup(account, state, attempt + 1), 8000);
  }
}

async function startFishing(account, state) {
  const bot = state.bot;
  if (!bot || state.fishing) return;
  if (!state.rankupReady || state.location !== "rankup") {
    state.activity = "lobby: entrando no RankUP";
    await joinRankup(account, state);
    if (!state.rankupReady || state.location !== "rankup") throw new Error("A conta ainda está no lobby; o RankUP não foi confirmado.");
  }
  state.fishing = true;
  state.activity = "executando /pescar";
  state.lastError = null;
  try {
    const serverConfig = await loadServerConfig();
    let rod = bot.inventory.items().find((item) => item.name === "fishing_rod");
    if (!rod) {
      state.activity = "vara ausente: preparando kit iniciante";
      await runStarterKitWithRetry(account, state);
      rod = bot.inventory.items().find((item) => item.name === "fishing_rod");
      if (!rod) throw new Error("O /kit iniciante não entregou uma vara de pesca.");
    }
    bot.chat(String(serverConfig.fishCommand || "/pescar").trim() || "/pescar");
    await sleep(5000);
    rod = bot.inventory.items().find((item) => item.name === "fishing_rod");
    if (!rod) throw new Error("A vara desapareceu antes de iniciar a pesca.");
    if (rod.slot >= 36 && rod.slot <= 44) bot.setQuickBarSlot(rod.slot - 36);
    else await bot.equip(rod, "hand");
    await sleep(300);
    bot.activateItem();
    state.location = "pesca";
    state.activity = "pescando";
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : "Falha na rotina de pesca";
    state.fishing = false;
    state.activity = "parado";
  }
}

async function waitForAccountReady(account, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = bots.get(account.id);
    if (!state) throw new Error("Estado da conta não foi criado.");
    if (state.status === "offline" && !state.bot) throw new Error(state.lastError || "A conta desconectou antes de entrar no RankUP.");
    if (state.status === "online" && (state.rankupReady || state.activity === "aguardando comandos" || state.activity === "pescando")) return state;
    if (/não confirmou o login|senha incorreta|password/i.test(state.lastError || "")) throw new Error(state.lastError);
    await sleep(500);
  }
  const state = bots.get(account.id);
  throw new Error(state?.lastError || "Tempo esgotado aguardando login e entrada no RankUP.");
}

async function runAutomatic(account) {
  if (accountAutomations.has(account.id)) return accountAutomations.get(account.id);
  let state = bots.get(account.id);
  const operation = (async () => {
    state = bots.get(account.id);
    if (state?.bot && state.status === "online" && state.activity === "automático com erro" && !state.rankupReady) {
      state.intentionalDisconnect = true;
      state.lastError = null;
      state.bot.quit("Repetindo fluxo automático");
      const reconnectDeadline = Date.now() + 5000;
      while (state.bot && Date.now() < reconnectDeadline) await sleep(200);
      state = bots.get(account.id);
    }
    let ready = false;
    let lastConnectError = null;
    for (let attempt = 1; attempt <= 3 && !ready; attempt += 1) {
      try {
        if (!state?.bot) await connect(account);
        state = bots.get(account.id);
        if (!state) throw new Error("Conta sem estado de conexão.");
        state = await waitForAccountReady(account);
        ready = true;
      } catch (error) {
        lastConnectError = error;
        const message = String(error?.message || error);
        // Falha de proxy é quase sempre transitória: antes ela derrubava a conta
        // na primeira tentativa porque só "já está online" era re-tentado.
        // Depois de uma queda seca o servidor ainda considera a conta online.
        // Voltar em 8s só rende outro kick; espera a sessão expirar lá.
        const fantasma = /j[aá] est[aá] (?:online|neste proxy|conectado)|already (?:online|connected)|logged in from another/i.test(message);
        const retryable = /sess[aã]o|proxy|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|socket closed/i;
        if (error?.configuracao || attempt >= 3 || bots.get(account.id)?.blocked || !(fantasma || retryable.test(message))) throw error;
        state = bots.get(account.id);
        if (state?.bot) {
          state.intentionalDisconnect = true;
          state.bot.quit("Limpando sessão anterior");
        }
        if (fantasma) {
          state = bots.get(account.id);
          if (state) state.activity = "aguardando a sessão anterior expirar";
        }
        await sleep(fantasma ? ghostSessionWait : attempt * 8000);
        state = bots.get(account.id);
      }
    }
    if (!ready) throw lastConnectError || new Error("Não consegui confirmar a sessão.");
    state.automationRunning = true;
    state.lastError = null;
    state.activity = state.status === "online" ? state.activity : "automático: conectando";
    if (state.activity === "pescando" && state.fishing) return publicState(account);
    state.activity = "automático: verificando vara";
    let rod = state.bot.inventory.items().find((item) => item.name === "fishing_rod");
    if (!rod) {
      state.activity = "automático: preparando kit";
      await runStarterKitWithRetry(account, state);
      rod = state.bot.inventory.items().find((item) => item.name === "fishing_rod");
      if (!rod) throw new Error("O fluxo do kit terminou sem vara de pesca.");
    }
    state.activity = "automático: iniciando pesca";
    await startFishing(account, state);
    await sleep(700);
    if (!state.fishing || state.activity !== "pescando") throw new Error(state.lastError || "A pesca não iniciou.");
    return publicState(account);
  })();
  accountAutomations.set(account.id, operation);
  state = bots.get(account.id);
  if (state) { state.automationRunning = true; state.automationPromise = operation; }
  try { return await operation; }
  catch (error) {
    const failedState = bots.get(account.id);
    if (failedState) { failedState.lastError = error instanceof Error ? error.message : "Falha no automático"; failedState.activity = failedState.blocked ? "bloqueado pelo servidor" : "automático com erro"; }
    throw error;
  } finally {
    const finalState = bots.get(account.id);
    if (finalState) { finalState.automationRunning = false; finalState.automationPromise = null; }
    accountAutomations.delete(account.id);
  }
}

async function waitGroupDelay(milliseconds, runId) {
  const deadline = Date.now() + milliseconds;
  while (groupAutomation.running && groupAutomation.runId === runId && Date.now() < deadline) await sleep(Math.min(1000, deadline - Date.now()));
}

async function runGroupAutomation(runId) {
  const accounts = await loadAccounts();
  groupAutomation.completedGroups = [];
  groupAutomation.failedAccounts = [];
  const falhas = [];
  const total = accounts.length;

  // Uma conta por vez, na ordem da lista: conectar em rajada marca o IP no
  // servidor e derruba as contas que já estavam dentro.
  for (let index = 0; index < total && groupAutomation.running && groupAutomation.runId === runId; index += 1) {
    const account = accounts[index];
    const posicao = `${index + 1}/${total}`;
    groupAutomation.currentGroup = account.proxyId || "IP residencial";
    groupAutomation.currentAccounts = [account.username];
    groupAutomation.nextGroupAt = null;
    groupAutomation.message = `Conectando ${account.username} (${posicao})`;

    try {
      await runAutomatic(account);
      groupAutomation.completedGroups.push(account.username);
    } catch (error) {
      falhas.push({ username: account.username, error: String(error?.message || error).slice(0, 120) });
      groupAutomation.failedAccounts = falhas.slice(-25);
    }

    if (!groupAutomation.running || groupAutomation.runId !== runId) break;
    if (index + 1 < total) {
      groupAutomation.nextGroupAt = new Date(Date.now() + sequentialDelay).toISOString();
      groupAutomation.message = `${groupAutomation.completedGroups.length} conectada(s), ${falhas.length} falha(s) — próxima em ${Math.round(sequentialDelay / 1000)}s`;
      await waitGroupDelay(sequentialDelay, runId);
    }
  }

  if (groupAutomation.runId !== runId) return;
  const resumo = `${groupAutomation.completedGroups.length} conectada(s), ${falhas.length} falha(s)`;
  groupAutomation.message = groupAutomation.running ? `Fila concluída: ${resumo}` : `Automação interrompida: ${resumo}`;
  groupAutomation.running = false;
  groupAutomation.currentGroup = null;
  groupAutomation.currentAccounts = [];
  groupAutomation.nextGroupAt = null;
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || "{}");
}

function inventorySnapshot(bot) {
  const counts = new Map();
  for (const item of bot.inventory.items()) {
    const key = `${item.type}:${item.metadata}`;
    counts.set(key, (counts.get(key) || 0) + item.count);
  }
  return counts;
}

async function purchaseAndDeliver(state, slot) {
  const bot = state.bot;
  const serverConfig = await loadServerConfig();
  state.activity = "abrindo mercado";
  if (!bot.currentWindow || !/mercado|pesca/i.test(bot.currentWindow.title || "")) {
    bot.chat(serverConfig.marketCommand);
    await waitForWindow(bot, 5000);
  }
  const window = bot.currentWindow;
  const slotNumber = Number(slot);
  if (!window || !Number.isInteger(slotNumber) || slotNumber < 0 || slotNumber >= window.inventoryStart || !window.slots[slotNumber]) throw new Error("Produto não encontrado no slot configurado do mercado.");
  const before = inventorySnapshot(bot);
  state.activity = "comprando";
  await bot.clickWindow(slotNumber, 0, 0);
  await sleep(1200);
  const purchased = bot.inventory.items().map((item) => {
    const previous = before.get(`${item.type}:${item.metadata}`) || 0;
    return { item, added: Math.max(0, item.count - previous) };
  }).filter((entry) => entry.added > 0);
  if (!purchased.length) throw new Error("A compra não gerou um item. O mercado pode ter aberto uma confirmação.");
  bot.closeWindow(bot.currentWindow);
  state.activity = "levando ao plot";
  bot.chat(serverConfig.plotCommand);
  await sleep(4500);
  state.activity = "dropando compra";
  for (const entry of purchased) await bot.toss(entry.item.type, entry.item.metadata, entry.added);
  queryBalance(state, bot, serverConfig);
  state.activity = "entrega concluída";
}

function countInventoryKey(bot, key) {
  return bot.inventory.items().filter((item) => `${item.type}:${item.metadata}` === key).reduce((sum, item) => sum + item.count, 0);
}

async function purchaseToInventory(state, slot, requestedQuantity = 1) {
  const bot = state.bot;
  const serverConfig = await loadServerConfig();
  state.activity = "abrindo mercado";
  state.purchaseNotice = null;
  if (!bot.currentWindow || !/mercado|pesca/i.test(bot.currentWindow.title || "")) {
    bot.chat(serverConfig.marketCommand);
    await waitForWindow(bot, 5000);
  }
  const window = bot.currentWindow;
  const slotNumber = Number(slot);
  if (!window || !Number.isInteger(slotNumber) || slotNumber < 0 || slotNumber >= window.inventoryStart || !window.slots[slotNumber]) throw new Error("Produto nao encontrado no slot do mercado.");
  const productKey = `${window.slots[slotNumber].type}:${window.slots[slotNumber].metadata}`;
  const before = countInventoryKey(bot, productKey);
  const quantity = Math.max(1, Math.min(2304, Math.floor(Number(requestedQuantity) || 1)));
  state.activity = "comprando";
  // O mercado abre o campo de quantidade com o botão direito; a confirmação
  // é feita enviando a quantidade pelo chat.
  await bot.clickWindow(slotNumber, 1, 0);
  await sleep(500);
  bot.chat(String(quantity));
  await sleep(1800);
  const purchased = Math.max(0, countInventoryKey(bot, productKey) - before);
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  if (purchased === quantity) state.purchaseNotice = `Compra concluida: ${purchased} unidade(s) no inventario.`;
  else if (purchased > 0) state.purchaseNotice = `Compra parcial: ${purchased}/${quantity} unidade(s). Saldo ou limite insuficiente.`;
  else state.purchaseNotice = `Nao foi possivel comprar ${quantity} unidade(s). Verifique o saldo e o limite do mercado.`;
  queryBalance(state, bot, serverConfig);
  state.activity = "aguardando comandos";
}

function json(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" });
  response.end(JSON.stringify(data));
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") return json(response, 204, {});
  if (request.headers.authorization !== `Bearer ${apiKey}`) return json(response, 401, { error: "Não autorizado" });
  try {
    const accounts = await loadAccounts();
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/health") { const configured = await loadServerConfig(); return json(response, 200, { ok: true, host: configured.host, minecraftPort: configured.port, version: configured.version, unlimited: true }); }
    if (request.method === "GET" && url.pathname === "/accounts") return json(response, 200, accounts.map(publicState));
    if (request.method === "GET" && url.pathname === "/automation/status") return json(response, 200, { ...groupAutomation, currentAccounts: [...groupAutomation.currentAccounts], completedGroups: [...groupAutomation.completedGroups], failedAccounts: [...groupAutomation.failedAccounts] });
    if (request.method === "POST" && url.pathname === "/automation/groups/start") {
      if (groupAutomation.running) return json(response, 409, { error: "A automação por grupos já está em execução" });
      groupAutomation.running = true;
      groupAutomation.runId += 1;
      const runId = groupAutomation.runId;
      groupAutomation.startedAt = new Date().toISOString();
      groupAutomation.currentGroup = null;
      groupAutomation.currentAccounts = [];
      groupAutomation.completedGroups = [];
      groupAutomation.failedAccounts = [];
      groupAutomation.nextGroupAt = null;
      groupAutomation.message = "Preparando o primeiro grupo";
      runGroupAutomation(runId).catch((error) => {
        if (groupAutomation.runId !== runId) return;
        groupAutomation.running = false;
        groupAutomation.nextGroupAt = null;
        groupAutomation.message = `Automação encerrada com erro: ${error instanceof Error ? error.message : String(error)}`;
      });
      return json(response, 202, { ...groupAutomation });
    }
    if (request.method === "POST" && url.pathname === "/automation/groups/stop") {
      if (!groupAutomation.running) return json(response, 200, { ...groupAutomation });
      groupAutomation.running = false;
      groupAutomation.runId += 1;
      groupAutomation.nextGroupAt = null;
      groupAutomation.message = "Parando após as operações atuais";
      return json(response, 202, { ...groupAutomation });
    }
    if (request.method === "GET" && url.pathname === "/config") {
      const proxies = await loadProxies();
      const usage = Object.fromEntries(proxies.map((proxy) => [proxy.id, accounts.filter((account) => account.proxyId === proxy.id).length]));
      return json(response, 200, {
        maxAccounts: null,
        maxPerProxy,
        server: await loadServerConfig(),
        accounts: accounts.map((account) => ({ id: account.id, username: account.username, proxyId: account.proxyId || null })),
        proxies: proxies.map((proxy) => ({ id: proxy.id, host: proxy.host, port: proxy.port, username: proxy.username ? "configurado" : null, usage: usage[proxy.id] || 0 })),
      });
    }
    if (request.method === "POST" && url.pathname === "/config/proxies/test") {
      const configured = await loadServerConfig();
      const inUse = new Set(accounts.map((account) => account.proxyId).filter(Boolean));
      const proxies = (await loadProxies()).filter((proxy) => inUse.has(proxy.id));
      const results = [];
      // Em blocos para não abrir centenas de sockets de uma vez.
      for (let offset = 0; offset < proxies.length; offset += 10) {
        results.push(...await Promise.all(proxies.slice(offset, offset + 10).map(async (proxy) => {
          const started = Date.now();
          try {
            const socket = await openProxyTunnel(proxy, { host: configured.host, port: configured.port }, proxyConnectTimeout);
            socket.destroy();
            return { id: proxy.id, ok: true, ms: Date.now() - started, error: null };
          } catch (error) {
            return { id: proxy.id, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
          }
        })));
      }
      return json(response, 200, { tested: results.length, healthy: results.filter((entry) => entry.ok).length, results });
    }
    if (request.method === "POST" && url.pathname === "/config/server") {
      if ([...bots.values()].some((state) => state.bot)) return json(response, 409, { error: "Desconecte todas as contas antes de trocar o servidor" });
      const body = await readBody(request);
      const configured = {
        host: String(body.host || "").trim(), port: Number(body.port), version: String(body.version || "1.8.9").trim(),
        loginCommand: String(body.loginCommand || "").trim(), plotCommand: String(body.plotCommand || "").trim(), fishCommand: String(body.fishCommand || "").trim(),
        marketCommand: String(body.marketCommand || "").trim(), balanceCommand: String(body.balanceCommand || "").trim(),
      };
      if (!configured.host || !Number.isInteger(configured.port) || configured.port < 1 || configured.port > 65535 || !configured.version) return json(response, 400, { error: "IP, porta e versão são obrigatórios" });
      await writeJsonAtomic("server.json", configured);
      return json(response, 200, configured);
    }
    if (request.method === "POST" && url.pathname === "/config/proxies") {
      const body = await readBody(request);
      const id = String(body.id || `proxy-${Date.now()}`).trim().replace(/[^a-zA-Z0-9_-]/g, "-");
      const hostValue = String(body.host || "").trim();
      const portValue = Number(body.port);
      if (!id || !hostValue || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) return json(response, 400, { error: "Proxy SOCKS5 inválido" });
      const proxies = await loadProxies();
      if (proxies.some((proxy) => proxy.id === id)) return json(response, 409, { error: "Já existe um proxy com esse nome" });
      proxies.push({ id, host: hostValue, port: portValue, username: String(body.username || ""), password: String(body.password || "") });
      await writeJsonAtomic("proxies.json", proxies);
      return json(response, 201, { id, host: hostValue, port: portValue });
    }
    if (request.method === "POST" && url.pathname === "/config/webshare/import") {
      if ([...bots.values()].some((state) => state.bot)) return json(response, 409, { error: "Desconecte as contas antes de distribuir novos proxies" });
      const { token } = await readBody(request);
      const apiToken = String(token || "").trim();
      if (!apiToken) return json(response, 400, { error: "Informe a chave da API Webshare" });
      let nextUrl = "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100";
      const imported = [];
      while (nextUrl && imported.length < 500) {
        const remote = await fetch(nextUrl, { headers: { authorization: `Token ${apiToken}`, accept: "application/json" } });
        if (!remote.ok) return json(response, remote.status === 401 ? 401 : 502, { error: remote.status === 401 ? "Chave Webshare inválida" : `Webshare respondeu com erro ${remote.status}` });
        const payload = await remote.json();
        for (const proxy of Array.isArray(payload.results) ? payload.results : []) {
          if (proxy.valid === false || !proxy.proxy_address || !Number(proxy.port)) continue;
          imported.push({ id: `webshare-${String(proxy.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`, host: proxy.proxy_address, port: Number(proxy.port), username: String(proxy.username || ""), password: String(proxy.password || "") });
        }
        nextUrl = typeof payload.next === "string" && payload.next.startsWith("https://proxy.webshare.io/") ? payload.next : null;
      }
      if (!imported.length) return json(response, 400, { error: "Nenhum proxy Direct válido foi encontrado na Webshare" });
      const existing = await loadProxies();
      const merged = [...existing.filter((proxy) => !proxy.id.startsWith("webshare-")), ...imported];
      await writeJsonAtomic("proxies.json", merged);
      return json(response, 201, { imported: imported.length, assigned: 0 });
    }
    if (request.method === "POST" && url.pathname === "/config/accounts/generate") {
      const body = await readBody(request);
      const baseName = String(body.baseName || "").trim().replace(/[^a-zA-Z0-9_]/g, "");
      const count = Number(body.count);
      const start = Number(body.start || 1);
      const pad = Math.max(0, Math.min(4, Number(body.pad ?? 2)));
      const password = String(body.password || "");
      if (!baseName || !password || !Number.isInteger(count) || count < 1 || !Number.isInteger(start) || start < 0) return json(response, 400, { error: "Nome, senha, início e quantidade são obrigatórios" });
      const proxies = await loadProxies();
      const connectionMode = body.connectionMode === "local" ? "local" : "proxy";
      const useProxies = connectionMode === "proxy";
      const requestedProxyId = String(body.proxyId || "auto");
      const authenticatedProxies = proxies.filter((proxy) => proxy.username && proxy.password);
      if (useProxies && !proxies.length) return json(response, 400, { error: "Cadastre pelo menos um proxy SOCKS5" });
      if (useProxies && !authenticatedProxies.length) return json(response, 400, { error: "Cadastre uma proxy autenticada com usuário e senha" });
      if (useProxies && requestedProxyId !== "auto" && !authenticatedProxies.some((proxy) => proxy.id === requestedProxyId)) return json(response, 400, { error: "A proxy escolhida não existe ou não possui autenticação" });
      const usage = new Map(proxies.map((proxy) => [proxy.id, accounts.filter((account) => account.proxyId === proxy.id).length]));
      const proxyAssignments = [];
      if (useProxies) {
        let remaining = count;
        while (remaining > 0) {
          const blockSize = Math.min(maxPerProxy, remaining);
          const chosen = authenticatedProxies.find((proxy) => (requestedProxyId === "auto" || proxy.id === requestedProxyId) && maxPerProxy - (usage.get(proxy.id) || 0) >= blockSize);
          if (!chosen) return json(response, 400, { error: `Nenhum proxy possui ${blockSize} vagas juntas. Adicione outro proxy.` });
          for (let slot = 0; slot < blockSize; slot++) proxyAssignments.push(chosen.id);
          usage.set(chosen.id, (usage.get(chosen.id) || 0) + blockSize);
          remaining -= blockSize;
        }
      }
      const created = [];
      for (let index = 0; index < count; index++) {
        const suffix = String(start + index).padStart(pad, "0");
        const username = `${baseName}${suffix}`;
        if ([...accounts, ...created].some((account) => account.username.toLowerCase() === username.toLowerCase())) return json(response, 409, { error: `A conta ${username} já existe` });
        let proxyId = null;
        if (useProxies) {
          proxyId = proxyAssignments[index];
        }
        created.push({ id: username, username, auth: "offline", serverPassword: password, proxyId, allowLocal: !useProxies, registered: false });
      }
      await appendAccounts(created);
      return json(response, 201, { created: created.map(({ username, proxyId }) => ({ username, proxyId })) });
    }
    // O serviço sobrevive ao fechar/abrir do app, então o erro de uma sessão
    // antiga ficaria na tela para sempre. Só limpa quem está desconectado.
    if (request.method === "POST" && url.pathname === "/accounts/errors/clear") {
      let cleared = 0;
      for (const state of bots.values()) {
        if (state.bot || !state.lastError) continue;
        state.lastError = null;
        state.blocked = false;
        state.blockedReason = null;
        state.kitNotice = null;
        state.kitBlocked = false;
        state.activity = "parado";
        cleared += 1;
      }
      return json(response, 200, { cleared });
    }
    const detailMatch = url.pathname.match(/^\/accounts\/([^/]+)\/detail$/);
    if (request.method === "GET" && detailMatch) {
      const account = accounts.find((item) => item.id === decodeURIComponent(detailMatch[1]));
      if (!account) return json(response, 404, { error: "Conta não encontrada" });
      return json(response, 200, publicState(account, { detailed: true }));
    }
    const match = url.pathname.match(/^\/accounts\/([^/]+)\/(connect|disconnect|chat|fish|pause|plot|kit|market|drop|dropall|buy|purchase|balance|rankup|auto)$/);
    if (request.method === "POST" && match) {
      const account = accounts.find((item) => item.id === decodeURIComponent(match[1]));
      if (!account) return json(response, 404, { error: "Conta não encontrada" });
      const action = match[2];
      if (action === "connect") return json(response, 202, await connect(account));
      if (action === "auto") {
        runAutomatic(account).catch((error) => console.error(`[${account.username}] automático: ${error instanceof Error ? error.message : String(error)}`));
        return json(response, 202, publicState(account));
      }
      const state = bots.get(account.id);
      const bot = state?.bot;
      const serverConfig = await loadServerConfig();
      if (!bot || state.status !== "online") return json(response, 409, { error: "Conta offline" });
      if (action === "disconnect") { state.fishing = false; state.intentionalDisconnect = true; state.lastError = null; bot.quit("Desconectado pelo painel"); }
      if (action === "fish") startFishing(account, state).catch((error) => { state.lastError = error instanceof Error ? error.message : "Falha ao iniciar pesca"; state.activity = "erro: pesca"; });
      if (action === "pause") { state.fishing = false; state.activity = "parado"; bot.deactivateItem(); bot.clearControlStates(); }
      if (action === "plot") { state.fishing = false; state.activity = "indo ao destino"; state.location = "plot"; bot.chat(serverConfig.plotCommand); setTimeout(() => { if (state.activity === "indo ao destino") state.activity = "no destino"; }, 5000); }
      if (action === "kit") {
        try { await runStarterKitWithRetry(account, state); }
        catch (error) { state.lastError = error instanceof Error ? error.message : "Falha no kit iniciante"; state.activity = "erro no kit"; throw error; }
      }
      if (action === "market") { state.activity = "mercado"; bot.chat(serverConfig.marketCommand); }
      if (action === "balance") queryBalance(state, bot, serverConfig);
      if (action === "rankup") joinRankup(account, state);
      if (action === "chat") {
        const { message } = await readBody(request);
        if (typeof message !== "string" || !message.trim() || message.length > 256) return json(response, 400, { error: "Mensagem inválida" });
        const sent = message.trim();
        bot.chat(sent);
        state.messages.push({ at: new Date().toISOString(), text: sent, direction: "out" });
        if (state.messages.length > 30) state.messages.splice(0, state.messages.length - 30);
      }
      if (action === "drop") {
        const { itemName, count } = await readBody(request);
        const matching = bot.inventory.items().filter((entry) => entry.name === itemName || entry.displayName.toLowerCase() === String(itemName).toLowerCase());
        if (!matching.length) return json(response, 404, { error: "Item não encontrado no inventário" });
        state.lastError = null;
        const total = matching.reduce((sum, entry) => sum + entry.count, 0);
        let remaining = Math.max(1, Math.min(Number(count) || total, total));
        for (const stack of matching) {
          if (remaining <= 0) break;
          if (remaining >= stack.count) {
            await tossStackVerified(bot, stack);
            remaining -= stack.count;
          } else {
            await bot.toss(stack.type, stack.metadata, remaining);
            remaining = 0;
          }
        }
      }
      if (action === "dropall") {
        state.activity = "dropando inventário";
        const failed = [];
        for (const item of [...bot.inventory.items()].filter((entry) => !protectedItems.has(entry.name))) {
          try { await tossStackVerified(bot, item); await sleep(120); }
          catch { failed.push(item.displayName || item.name); }
        }
        state.activity = "parado";
        if (failed.length) state.lastError = `Itens não dropados: ${failed.join(", ")}`;
      }
      if (action === "buy") {
        const { slot } = await readBody(request);
        const window = bot.currentWindow;
        if (!window || !/mercado|pesca/i.test(window.title || "")) return json(response, 409, { error: "Abra o mercado antes de comprar" });
        const slotNumber = Number(slot);
        if (!Number.isInteger(slotNumber) || slotNumber < 0 || slotNumber >= window.inventoryStart || !window.slots[slotNumber]) return json(response, 400, { error: "Slot de mercado inválido" });
        await bot.clickWindow(slotNumber, 0, 0);
        state.activity = "comprando no mercado";
        setTimeout(() => queryBalance(state, bot, serverConfig), 1000);
      }
      if (action === "purchase") {
        const { slot, quantity } = await readBody(request);
        await purchaseToInventory(state, slot, quantity);
      }
      return json(response, 202, publicState(account));
    }
    return json(response, 404, { error: "Rota não encontrada" });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : "Erro interno" });
  }
});

server.listen(port, "127.0.0.1", async () => { const configured = await loadServerConfig(); console.log(`Bot service em http://127.0.0.1:${port} | Minecraft ${configured.host}:${configured.port} ${configured.version}`); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { for (const state of bots.values()) state.bot?.quit("Serviço encerrado"); server.close(() => process.exit(0)); });
