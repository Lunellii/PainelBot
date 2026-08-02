import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
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
const requireProxy = env.REQUIRE_PROXY !== "false";
const bots = new Map();
const accountAutomations = new Map();
let accountWriteQueue = Promise.resolve();
const groupAutomation = { running: false, runId: 0, startedAt: null, currentGroup: null, currentAccounts: [], completedGroups: [], failedAccounts: [], nextGroupAt: null, message: "Parado" };
const protectedItems = new Set(["glass_bottle", "slime", "slime_block", "shears", "compass", "clock", "nether_star"]);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

async function loadAccounts() {
  const accounts = JSON.parse(await readFile(resolve(configRoot, "accounts.json"), "utf8"));
  if (!Array.isArray(accounts) || accounts.length < 1) throw new Error("accounts.json deve conter pelo menos uma conta.");
  return accounts;
}

function markAccountRegistered(account) {
  if (account.registered === true) return;
  account.registered = true;
  accountWriteQueue = accountWriteQueue.then(async () => {
    const accounts = await loadAccounts();
    const saved = accounts.map((entry) => entry.id === account.id ? { ...entry, registered: true } : entry);
    await writeFile(resolve(configRoot, "accounts.json"), JSON.stringify(saved, null, 2), "utf8");
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
    await writeFile(resolve(configRoot, "accounts.json"), JSON.stringify(saved, null, 2), "utf8");
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

function publicState(account) {
  const state = bots.get(account.id);
  const inventory = inventoryOf(state?.bot);
  return {
    id: account.id,
    username: account.username,
    status: state?.status || "offline",
    activity: state?.activity || "parado",
    location: state?.location || (state?.rankupReady ? "rankup" : "lobby"),
    fishCount: state?.fishBalance ?? account.fishBalance ?? 0,
    balanceUpdatedAt: state?.balanceUpdatedAt || account.balanceUpdatedAt || null,
    inventory,
    market: marketOf(state),
    lastMessage: state?.lastMessage || null,
    lastMessageAt: state?.lastMessageAt || null,
    chatMessages: state?.messages || [],
    lastError: state?.lastError || null,
    purchaseNotice: state?.purchaseNotice || null,
    connectedAt: state?.connectedAt || null,
    automationRunning: state?.automationRunning || false,
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

async function connect(account) {
  const current = bots.get(account.id);
  if (current?.bot) return publicState(account);
  const allowedLocalAccount = account.allowLocal === true || /^vulkspesca(?:0[2-9])?$/i.test(account.username);
  if (!account.proxyId && (requireProxy || !allowedLocalAccount)) throw new Error(`Conexão local bloqueada para ${account.username}. Esta conta precisa de proxy.`);
  const state = { bot: null, status: "conectando", activity: "conectando", location: "lobby", registrationBlocked: false, intentionalDisconnect: false, fishing: false, automationRunning: false, automationPromise: null, rankupReady: false, fishBalance: Number(account.fishBalance) || 0, balanceUpdatedAt: account.balanceUpdatedAt || null, balanceRequestedAt: 0, balancePending: false, balanceTimeout: null, balanceRefreshTimer: null, balanceError: null, market: [], messages: [], balanceTimer: null, authTimer: null, authenticated: false, lastError: null, lastMessage: null, lastMessageAt: null, connectedAt: null, authAttempts: 0, lastAuthAt: 0, joinTimer: null };
  bots.set(account.id, state);
  const serverConfig = await loadServerConfig();
  const options = { host: serverConfig.host, port: serverConfig.port, version: serverConfig.version, username: account.username, auth: account.auth || "offline", hideErrors: true };
  if (account.proxyId) {
    const proxy = (await loadProxies()).find((item) => item.id === account.proxyId);
    if (!proxy) throw new Error(`Proxy não encontrado para ${account.username}`);
    options.connect = (client) => {
      SocksClient.createConnection({ proxy: { host: proxy.host, port: Number(proxy.port), type: 5, userId: proxy.username || undefined, password: proxy.password || undefined }, command: "connect", destination: { host: serverConfig.host, port: serverConfig.port }, timeout: 30000 })
        .then(({ socket }) => { client.setSocket(socket); client.emit("connect"); })
        .catch((error) => { state.lastError = error.message; state.status = "offline"; state.activity = "parado"; state.bot = null; client.emit("error", error); client.end(); });
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
    const recentBalanceRequest = state.balancePending && Date.now() - state.balanceRequestedAt < 20000;
    const balance = recentBalanceRequest ? parseBalanceReply(state.lastMessage) : null;
    if (balance !== null) {
      state.fishBalance = balance;
      state.balanceUpdatedAt = new Date().toISOString();
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
  bot.on("kicked", (reason) => { state.lastError = `Expulso: ${String(reason).slice(0, 300)}`; console.error(`[${account.username}] ${state.lastError}`); });
  bot.on("error", (error) => { state.lastError = error.message; console.error(`[${account.username}] ${error.message}`); });
  bot.once("end", (reason) => { if (state.balanceTimer) clearInterval(state.balanceTimer); if (state.balanceTimeout) clearTimeout(state.balanceTimeout); if (state.balanceRefreshTimer) clearTimeout(state.balanceRefreshTimer); if (state.authTimer) clearTimeout(state.authTimer); if (state.joinTimer) clearTimeout(state.joinTimer); const expectedEnd = state.intentionalDisconnect || /Desconectado pelo painel|Repetindo fluxo automático/i.test(String(reason || "")); if (expectedEnd) state.lastError = null; else if (!state.lastError && reason) state.lastError = `Conexão encerrada: ${String(reason).slice(0, 200)}`; state.bot = null; state.status = "offline"; state.activity = "parado"; state.location = "offline"; state.fishing = false; state.rankupReady = false; state.balancePending = false; console.log(`[${account.username}] desconectou`); });
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

async function moveInventoryToTrash(bot, state) {
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  await sleep(200);
  bot.chat("/lixeira");
  const window = await waitForWindow(bot, 6000);
  if (!Number.isInteger(window.inventoryStart)) throw new Error("A /lixeira não abriu um inventário válido.");
  const items = bot.inventory.items().filter((item) => item.name !== "fishing_rod");
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
  state.activity = "pegando kit iniciante";
  bot.chat("/kit iniciante");
  await sleep(3500);

  let rod = bot.inventory.items().find((item) => item.name === "fishing_rod");
  if (!rod) throw new Error("O /kit iniciante não entregou uma vara de pesca.");
  const firstHotbarSlot = 36;
  if (rod.slot !== firstHotbarSlot) {
    state.activity = "movendo vara para o slot 1";
    await putRodInFirstHotbarSlot(bot, rod);
  }

  rod = bot.inventory.items().find((item) => item.name === "fishing_rod");
  if (!rod) throw new Error("A vara desapareceu durante a organização do inventário.");
  bot.setQuickBarSlot(0);

  for (let pass = 0; pass < 3; pass += 1) {
    const leftovers = bot.inventory.items().filter((item) => item.name !== "fishing_rod");
    if (!leftovers.length) break;
    state.activity = `limpando inventário na /lixeira (${pass + 1}/3)`;
    await moveInventoryToTrash(bot, state);
  }
  const leftovers = bot.inventory.items().filter((item) => item.name !== "fishing_rod");
  rod = bot.inventory.items().find((item) => item.name === "fishing_rod");
  if (!rod) throw new Error("A vara desapareceu durante a limpeza na /lixeira.");
  if (rod.slot !== firstHotbarSlot) await putRodInFirstHotbarSlot(bot, rod);
  bot.setQuickBarSlot(0);
  if (leftovers.length) throw new Error(`A /lixeira não removeu: ${leftovers.map((item) => item.displayName || item.name).join(", ")}`);
  state.activity = "aguardando comandos";
  console.log(`[${account.username}] kit preparado: somente a vara permaneceu no slot 1`);
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
    bot.chat(serverConfig.fishCommand);
    await sleep(5000);
    const rod = bot.inventory.items().find((item) => item.name === "fishing_rod");
    if (!rod) throw new Error("A conta está sem vara de pesca. Use 'Ir ao meu plot' e entregue uma vara.");
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
    if (!state?.bot) {
      await connect(account);
      state = bots.get(account.id);
    }
    if (!state) throw new Error("Não consegui iniciar a conta.");
    state.automationRunning = true;
    state.lastError = null;
    state.activity = state.status === "online" ? state.activity : "automático: conectando";
    state = await waitForAccountReady(account);
    if (state.activity === "pescando" && state.fishing) return publicState(account);
    state.activity = "automático: verificando vara";
    let rod = state.bot.inventory.items().find((item) => item.name === "fishing_rod");
    if (!rod) {
      state.activity = "automático: preparando kit";
      await runStarterKit(account, state);
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
    if (failedState) { failedState.lastError = error instanceof Error ? error.message : "Falha no automático"; failedState.activity = "automático com erro"; }
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
  const grouped = new Map();
  for (const account of accounts) {
    const groupId = account.proxyId || "IP residencial";
    if (!grouped.has(groupId)) grouped.set(groupId, []);
    grouped.get(groupId).push(account);
  }
  const groups = [];
  for (const [id, members] of grouped.entries()) {
    const totalParts = Math.ceil(members.length / 10);
    for (let offset = 0, part = 1; offset < members.length; offset += 10, part += 1) {
      const batchMembers = members.slice(offset, offset + 10);
      const baseNames = [...new Set(batchMembers.map((account) => account.username.replace(/\d+$/, "")))];
      const baseLabel = baseNames.length === 1 ? baseNames[0] : id;
      groups.push({ id, label: totalParts > 1 ? `${baseLabel} ${part}/${totalParts}` : baseLabel, members: batchMembers });
    }
  }
  groupAutomation.completedGroups = [];
  for (let index = 0; index < groups.length && groupAutomation.running && groupAutomation.runId === runId; index += 1) {
    const group = groups[index];
    groupAutomation.currentGroup = group.label;
    groupAutomation.currentAccounts = group.members.map((account) => account.username);
    groupAutomation.failedAccounts = [];
    groupAutomation.nextGroupAt = null;
    let pending = [...group.members];
    let round = 0;
    while (groupAutomation.running && groupAutomation.runId === runId && pending.length) {
      round += 1;
      groupAutomation.message = `Processando ${group.label}: tentativa ${round}`;
      const results = await Promise.allSettled(pending.map((account) => runAutomatic(account)));
      const failed = results.map((result, resultIndex) => ({ result, account: pending[resultIndex] })).filter(({ result }) => result.status === "rejected");
      groupAutomation.failedAccounts = failed.map(({ account, result }) => ({ username: account.username, error: String(result.reason?.message || result.reason || "Falha") }));
      pending = failed.map(({ account }) => account);
      if (pending.length && groupAutomation.running && groupAutomation.runId === runId) {
        groupAutomation.message = `${pending.length} conta(s) falharam; nova tentativa em 1 minuto`;
        await waitGroupDelay(60000, runId);
      }
    }
    if (!groupAutomation.running || groupAutomation.runId !== runId) break;
    groupAutomation.completedGroups.push(group.label);
    groupAutomation.failedAccounts = [];
    if (index < groups.length - 1) {
      groupAutomation.nextGroupAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      groupAutomation.message = `${group.label} concluido; proximo grupo em 2 minutos`;
      groupAutomation.message = `${group.label} concluído; próximo grupo em 15 minutos`;
      groupAutomation.message = `${group.label} concluido; proximo grupo em 2 minutos`;
      await waitGroupDelay(2 * 60 * 1000, runId);
    }
  }
  if (groupAutomation.runId !== runId) return;
  if (groupAutomation.running) groupAutomation.message = "Todos os grupos foram concluídos";
  else groupAutomation.message = "Automação interrompida";
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
  let purchased = 0;
  for (let attempt = 0; attempt < quantity; attempt += 1) {
    if (!bot.currentWindow) break;
    await bot.clickWindow(slotNumber, 0, 0).catch(() => {});
    await sleep(220);
    const current = countInventoryKey(bot, productKey);
    if (current <= before + purchased) break;
    purchased += current - before - purchased;
  }
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
    if (request.method === "POST" && url.pathname === "/config/server") {
      if ([...bots.values()].some((state) => state.bot)) return json(response, 409, { error: "Desconecte todas as contas antes de trocar o servidor" });
      const body = await readBody(request);
      const configured = {
        host: String(body.host || "").trim(), port: Number(body.port), version: String(body.version || "1.8.9").trim(),
        loginCommand: String(body.loginCommand || "").trim(), plotCommand: String(body.plotCommand || "").trim(), fishCommand: String(body.fishCommand || "").trim(),
        marketCommand: String(body.marketCommand || "").trim(), balanceCommand: String(body.balanceCommand || "").trim(),
      };
      if (!configured.host || !Number.isInteger(configured.port) || configured.port < 1 || configured.port > 65535 || !configured.version) return json(response, 400, { error: "IP, porta e versão são obrigatórios" });
      await writeFile(resolve(configRoot, "server.json"), JSON.stringify(configured, null, 2), "utf8");
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
      await writeFile(resolve(configRoot, "proxies.json"), JSON.stringify(proxies, null, 2), "utf8");
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
      await writeFile(resolve(configRoot, "proxies.json"), JSON.stringify(merged, null, 2), "utf8");
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
      await writeFile(resolve(configRoot, "accounts.json"), JSON.stringify([...accounts, ...created], null, 2), "utf8");
      return json(response, 201, { created: created.map(({ username, proxyId }) => ({ username, proxyId })) });
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
        try { await runStarterKit(account, state); }
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
