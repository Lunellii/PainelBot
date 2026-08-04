"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Item = { name: string; displayName: string; count: number; metadata: number; hotbarSlots: number[]; outsideHotbar: boolean };
type MarketItem = { slot: number; name: string; displayName: string; count: number; lore: string[] };
type ChatMessage = { at: string; text: string; direction: "in" | "out" };
type ManagerConfig = { maxAccounts: number | null; maxPerProxy: number; accounts: Array<{ id: string; username: string; proxyId: string | null }>; proxies: Array<{ id: string; host: string; port: number; username: string | null; usage: number }> };
type AutomationStatus = { running: boolean; startedAt: string | null; currentGroup: string | null; currentAccounts: string[]; completedGroups: string[]; failedAccounts: Array<{ username: string; error: string }>; nextGroupAt: string | null; message: string };
type ProxyTest = { tested: number; healthy: number; results: Array<{ id: string; ok: boolean; ms: number; error: string | null }> };
type Account = {
  id: string;
  username: string;
  proxyId?: string | null;
  status: "online" | "offline" | "conectando";
  activity: string;
  location?: "offline" | "lobby" | "rankup" | "pesca" | string;
  fishCount: number;
  fishPerMinute?: number;
  fishPerHour?: number;
  balanceUpdatedAt?: string | null;
  itemCount?: number;
  inventory: Item[];
  market?: MarketItem[];
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  chatMessages?: ChatMessage[];
  lastError?: string | null;
  purchaseNotice?: string | null;
  connectedAt?: string | null;
  automationRunning?: boolean;
  blocked?: boolean;
  blockedReason?: string | null;
  registered?: boolean;
  balancePending?: boolean;
  balanceError?: string | null;
  balanceStatus?: "atualizado" | "desatualizado" | "atualizando" | "erro" | "sem_dados";
};

// Usado só quando o servidor ainda não devolveu o menu real do mercado.
const knownMarket = [
  { name: "Chave Diamante", cost: "125K Peixes", slot: 11 },
  { name: "Removedor de Skin [RARO]", cost: "24K Peixes", slot: 12 },
  { name: "Tridente de Poseidon [COMUM]", cost: "1.2K Peixes", slot: 13 },
  { name: "Booster de Armadura 3x", cost: "8K Peixes", slot: 14 },
  { name: "Boss Tatu", cost: "15K Peixes", slot: 15 },
  { name: "Chave Ouro", cost: "200 Peixes", slot: 20 },
  { name: "HypeTrain", cost: "33.2K Peixes", slot: 21 },
  { name: "Chave Ferro", cost: "30 Peixes", slot: 22 },
  { name: "Booster de Coins 1.4x", cost: "12K Peixes", slot: 23 },
];

const format = (value: number) => new Intl.NumberFormat("pt-BR").format(value);
const balanceDisplay = (account: Account) => account.balanceUpdatedAt ? format(account.fishCount) : "—";
const balanceHint = (account: Account) => account.balanceStatus === "atualizando" ? "Consultando /peixes…" : account.balanceStatus === "desatualizado" ? "Saldo desatualizado" : account.balanceStatus === "erro" ? (account.balanceError || "Falha ao consultar") : account.balanceStatus === "sem_dados" ? "Ainda não consultado" : "Atualizado";
// O serviço devolve "lobby" como padrão mesmo para quem nunca conectou.
const localName = (account: Account) => account.status === "offline" ? "—" : account.location === "rankup" ? "RankUP" : account.location === "lobby" ? "Lobby" : account.location === "pesca" ? "Pesca" : account.location || "—";

// Cada falha pede uma ação diferente: reconectar não resolve um bloqueio do
// servidor, e um kit em cooldown não é problema de rede.
const errorKinds = [
  { id: "antibot", label: "Bloqueio do servidor", advice: "Reconectar repete o kick. Deixe estas contas de fora da rodada.", retryable: false, test: (a: Account) => Boolean(a.blocked) || /anti-?bot|bot detectado|uso de bot/i.test(a.lastError || "") },
  { id: "proxy", label: "Falha de proxy", advice: "Normalmente é transitório. Teste os proxies e re-tente.", retryable: true, test: (a: Account) => /^proxy |proxy|timed out|timeout|ECONN|ETIMEDOUT|EHOSTUNREACH|socket closed/i.test(a.lastError || "") },
  { id: "kit", label: "Kit iniciante", advice: "Cooldown ou inventário cheio; re-tentar só ajuda se já passou o tempo.", retryable: true, test: (a: Account) => /kit|vara de pesca/i.test(a.lastError || "") },
  { id: "login", label: "Login ou registro", advice: "Confira a senha da conta e o limite de contas por IP.", retryable: true, test: (a: Account) => /login|logar|registr|senha|limite de contas/i.test(a.lastError || "") },
  { id: "outro", label: "Outros erros", advice: "Abra os detalhes da conta para ler a mensagem completa.", retryable: true, test: () => true },
];

function classify(account: Account) {
  if (!account.lastError && !account.blocked) return null;
  return errorKinds.find((kind) => kind.test(account)) || errorKinds[errorKinds.length - 1];
}

const AccountRow = memo(function AccountRow({ account, checked, busy, onSelect, onOpen, onAction }: {
  account: Account;
  checked: boolean;
  busy: boolean;
  onSelect: (id: string, withShift: boolean) => void;
  onOpen: (id: string) => void;
  onAction: (id: string, action: string) => void;
}) {
  const kind = classify(account);
  const primary = account.status === "offline" ? "connect" : account.activity === "pescando" ? "pause" : "fish";
  const primaryLabel = account.status === "offline" ? "Conectar" : account.activity === "pescando" ? "Pausar" : "Pescar";
  return (
    <tr
      className={`${checked ? "checked" : ""} ${busy ? "row-busy" : ""}`}
      onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input")) onSelect(account.id, event.shiftKey); }}
      onMouseDown={(event) => { if (event.shiftKey && !(event.target as HTMLElement).closest("button, input")) event.preventDefault(); }}
    >
      <td className="col-check"><input type="checkbox" checked={checked} onChange={(event) => onSelect(account.id, event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)} aria-label={`Selecionar ${account.username}`} /></td>
      <td className="col-nick"><span className={`row-dot ${account.status}`} /><strong>{account.username}</strong></td>
      <td className="col-activity">
        <span title={account.activity}>{account.automationRunning ? `⟳ ${account.activity}` : account.activity}</span>
      </td>
      <td className="col-local">{localName(account)}</td>
      <td className={`col-balance balance-${account.balanceStatus || "sem_dados"}`} title={balanceHint(account)}>{balanceDisplay(account)}</td>
      <td className="col-items">{account.itemCount ?? 0}</td>
      <td className="col-proxy" title={account.proxyId || "IP residencial"}>{account.proxyId || "local"}</td>
      <td className="col-note">
        {kind
          ? <span className={`row-error kind-${kind.id}`} title={account.lastError || account.blockedReason || ""}>{account.lastError || account.blockedReason}</span>
          : <span className="row-message" title={account.lastMessage || ""}>{account.lastMessage || "—"}</span>}
      </td>
      <td className="col-actions">
        <button disabled={busy} onClick={() => onAction(account.id, primary)}>{primaryLabel}</button>
        <button onClick={() => onOpen(account.id)}>Detalhes</button>
      </td>
    </tr>
  );
}, (anterior, proximo) => {
  // O polling entrega objetos novos a cada 1,5s; sem comparar por valor toda
  // linha seria redesenhada mesmo sem nada ter mudado.
  if (anterior.checked !== proximo.checked || anterior.busy !== proximo.busy) return false;
  const a = anterior.account;
  const b = proximo.account;
  return a.username === b.username && a.status === b.status && a.activity === b.activity
    && a.automationRunning === b.automationRunning && a.location === b.location
    && a.fishCount === b.fishCount && a.balanceUpdatedAt === b.balanceUpdatedAt && a.balanceStatus === b.balanceStatus
    && a.itemCount === b.itemCount && a.proxyId === b.proxyId
    && a.lastError === b.lastError && a.blocked === b.blocked && a.blockedReason === b.blockedReason
    && a.lastMessage === b.lastMessage;
});

export default function Home() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [filter, setFilter] = useState<"todas" | "online" | "pescando" | "offline" | "problema">("todas");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("Conectando ao serviço local...");
  const [apiOnline, setApiOnline] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDetail, setActiveDetail] = useState<Account | null>(null);
  const [command, setCommand] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [batchCount, setBatchCount] = useState("20");
  const [batchProxy, setBatchProxy] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [managerOpen, setManagerOpen] = useState(false);
  const [manager, setManager] = useState<ManagerConfig | null>(null);
  const [proxyForm, setProxyForm] = useState({ id: "", host: "", port: "1080", username: "", password: "" });
  const [accountForm, setAccountForm] = useState({ baseName: "", start: "1", count: "1", pad: "2", password: "", connectionMode: "proxy", proxyId: "auto" });
  const [webshareToken, setWebshareToken] = useState("");
  const [proxyTest, setProxyTest] = useState<ProxyTest | null>(null);
  const [groupAutomation, setGroupAutomation] = useState<AutomationStatus | null>(null);
  const [accountsPanelOpen, setAccountsPanelOpen] = useState(false);
  const [registryQuery, setRegistryQuery] = useState("");
  const [purchaseQuantity, setPurchaseQuantity] = useState("1");

  // Com centenas de contas a resposta passa de 1,5s; sem esta trava as consultas
  // se acumulam, atropelam umas às outras e o painel se declara sem API.
  const emVoo = useRef(false);
  const refresh = useCallback(async () => {
    if (emVoo.current) return;
    emVoo.current = true;
    try {
      const [response, automationResponse] = await Promise.all([
        fetch("/api/accounts", { cache: "no-store" }),
        fetch("/api/automation/status", { cache: "no-store" }),
      ]);
      if (!response.ok) throw new Error("Serviço dos bots indisponível");
      setAccounts(await response.json());
      if (automationResponse.ok) setGroupAutomation(await automationResponse.json());
      setApiOnline(true);
      setLoaded(true);
    } catch {
      setApiOnline(false);
      setLoaded(true);
      setNotice("Serviço dos bots desconectado");
    } finally {
      emVoo.current = false;
    }
  }, []);

  const limparErros = useCallback(async (manual = false) => {
    try {
      const response = await fetch("/api/accounts/errors/clear", { method: "POST" });
      const data = await response.json();
      if (manual) setNotice(data.cleared ? `${data.cleared} erro(s) antigo(s) limpo(s)` : "Nenhum erro de conta desconectada para limpar");
      window.setTimeout(refresh, 200);
    } catch {
      if (manual) setNotice("Falha ao limpar os erros");
    }
  }, [refresh]);

  useEffect(() => {
    // Ao abrir o painel, apaga o erro de quem já está desconectado: são restos
    // da sessão anterior, já que o serviço não reinicia junto com o app.
    limparErros().finally(refresh);
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [refresh, limparErros]);

  // Inventário, chat e mercado só trafegam enquanto a conta está aberta.
  useEffect(() => {
    if (!activeId) { setActiveDetail(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/accounts/${encodeURIComponent(activeId)}/detail`, { cache: "no-store" });
        if (response.ok && alive) setActiveDetail(await response.json());
      } catch { /* o refresh da lista já sinaliza a API fora do ar */ }
    };
    load();
    const timer = window.setInterval(load, 1500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [activeId]);

  const visible = useMemo(() => accounts.filter((account) => {
    const text = account.username.toLowerCase().includes(query.toLowerCase());
    const match = filter === "todas" || account.status === filter || (filter === "pescando" && account.activity === "pescando") || (filter === "problema" && Boolean(account.lastError));
    return text && match;
  }), [accounts, query, filter]);
  const active = activeDetail && activeDetail.id === activeId ? activeDetail : accounts.find((account) => account.id === activeId) || null;
  const online = accounts.filter((account) => account.status === "online").length;
  const fishing = accounts.filter((account) => account.activity === "pescando").length;
  const failing = useMemo(() => accounts.filter((account) => classify(account)), [accounts]);
  const errors = failing.length;
  const knownBalances = accounts.filter((account) => account.balanceUpdatedAt);
  const fish = knownBalances.reduce((sum, account) => sum + account.fishCount, 0);
  const onlineRateAccounts = accounts.filter((account) => account.status === "online");
  const fishPerMinute = onlineRateAccounts.reduce((sum, account) => sum + (Number(account.fishPerMinute) || 0), 0);
  const fishPerHour = fishPerMinute * 60;
  const balanceTargets = accounts.filter((account) => selected.includes(account.id) && account.status === "online").map((account) => account.id);
  const registryVisible = useMemo(() => accounts.filter((account) => account.username.toLowerCase().includes(registryQuery.toLowerCase())), [accounts, registryQuery]);

  const triage = useMemo(() => errorKinds.map((kind) => {
    const members = failing.filter((account) => classify(account)?.id === kind.id);
    const proxies = [...new Set(members.map((account) => account.proxyId).filter(Boolean))] as string[];
    // Com centenas de contas na mesma causa, listar tudo vira ruído: mostra as
    // primeiras e resume o resto.
    const resumir = (lista: string[], limite: number) => lista.length > limite ? `${lista.slice(0, limite).join(", ")} +${lista.length - limite}` : lista.join(", ");
    return { ...kind, members, proxies, proxiesLabel: resumir(proxies, 6), namesLabel: resumir(members.map((account) => account.username), 8) };
  }).filter((group) => group.members.length), [failing]);

  function selectAccount(id: string, withShift: boolean) {
    setSelected((current) => {
      if (withShift && selectionAnchor) {
        const anchorIndex = visible.findIndex((account) => account.id === selectionAnchor);
        const targetIndex = visible.findIndex((account) => account.id === id);
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const start = Math.min(anchorIndex, targetIndex);
          const end = Math.max(anchorIndex, targetIndex);
          return [...new Set([...current, ...visible.slice(start, end + 1).map((account) => account.id)])];
        }
      }
      return current.includes(id) ? current.filter((accountId) => accountId !== id) : [...current, id];
    });
    setSelectionAnchor(id);
  }

  function selectVisible() {
    setSelected((current) => [...new Set([...current, ...visible.map((account) => account.id)])]);
    if (visible[0]) setSelectionAnchor(visible[0].id);
  }

  function clearSelection() {
    setSelected([]);
    setSelectionAnchor(null);
  }

  async function request(id: string, action: string, body?: object) {
    const response = await fetch(`/api/accounts/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Falha no comando");
    return result;
  }

  const act = useCallback(async (ids: string[], action: string, body?: object) => {
    if (!ids.length) return setNotice("Selecione pelo menos uma conta");
    setPending((current) => [...new Set([...current, ...ids])]);
    setNotice(`Executando ${action} em ${ids.length} conta(s)...`);
    const effectiveBody = action === "purchase" ? { ...(body || {}), quantity: Math.max(1, Number(purchaseQuantity) || 1) } : body;
    const results = await Promise.allSettled(ids.map((id) => request(id, action, effectiveBody)));
    const failed = results.filter((result) => result.status === "rejected");
    setNotice(failed.length ? `${results.length - failed.length} concluída(s), ${failed.length} falharam` : `Comando executado em ${ids.length} conta(s)`);
    if (action === "purchase") {
      const purchaseResult = results.find((result): result is PromiseFulfilledResult<Account> => result.status === "fulfilled" && Boolean(result.value.purchaseNotice));
      if (purchaseResult) setNotice(purchaseResult.value.purchaseNotice as string);
    }
    setPending((current) => current.filter((id) => !ids.includes(id)));
    window.setTimeout(refresh, 500);
  }, [purchaseQuantity, refresh]);

  const targets = selected;
  const actOne = useCallback((id: string, action: string) => { act([id], action); }, [act]);
  const openAccount = useCallback((id: string) => setActiveId(id), []);

  async function sendCommand() {
    if (!command.trim()) return;
    if (!selected.length) return setNotice("Selecione as contas para enviar o comando em lote");
    await act(selected, "chat", { message: command.trim() });
    setCommand("");
  }

  async function sendActiveChat() {
    if (!active || !chatDraft.trim()) return;
    try {
      await request(active.id, "chat", { message: chatDraft.trim() });
      setChatDraft("");
      setNotice(`Mensagem enviada por ${active.username}`);
      window.setTimeout(refresh, 250);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Falha ao enviar mensagem");
    }
  }

  async function connectBatch() {
    const amount = Math.max(1, Math.floor(Number(batchCount) || 1));
    const offlineAccounts = accounts.filter((account) => account.status === "offline");
    const groups = new Map<string, Account[]>();
    for (const account of offlineAccounts) {
      const key = account.proxyId || "local";
      groups.set(key, [...(groups.get(key) || []), account]);
    }
    let selectedProxy = batchProxy;
    if (selectedProxy === "auto") {
      const proxyGroups = [...groups.entries()].filter(([key]) => key !== "local");
      selectedProxy = proxyGroups.find(([, group]) => group.length >= amount)?.[0] || proxyGroups.sort((a, b) => b[1].length - a[1].length)[0]?.[0] || "local";
    }
    const offline = (groups.get(selectedProxy) || []).slice(0, amount);
    if (!offline.length) return setNotice("Nenhuma conta offline disponível");
    setBusy(true);
    let connected = 0;
    for (const account of offline) {
      setNotice(`Conectando lote: ${connected + 1}/${offline.length} · ${account.username}`);
      try { await request(account.id, "connect"); connected += 1; } catch { /* segue para a próxima conta do lote */ }
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
    setNotice(`Lote ${selectedProxy}: ${connected}/${offline.length} contas`);
    setBusy(false);
    window.setTimeout(refresh, 800);
  }

  async function controlGroupAutomation(action: "start" | "stop") {
    setBusy(true);
    try {
      const response = await fetch(`/api/automation/groups/${action}`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Falha na automação por grupos");
      setGroupAutomation(result);
      setNotice(action === "start" ? "Automação por grupos iniciada" : "Parada solicitada; as operações atuais serão finalizadas");
      window.setTimeout(refresh, 300);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Falha na automação por grupos");
    }
    setBusy(false);
  }

  async function loadManager() {
    const response = await fetch("/api/config", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Falha ao carregar configurações");
    setManager(data);
  }

  async function openManager() {
    setManagerOpen(true);
    try { await loadManager(); } catch (error) { setNotice(error instanceof Error ? error.message : "Falha ao carregar gerenciador"); }
  }

  async function testProxies() {
    setBusy(true);
    setNotice("Testando proxies em uso...");
    try {
      const response = await fetch("/api/config/proxies/test", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setProxyTest(data);
      setNotice(`${data.healthy}/${data.tested} proxies responderam`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Falha ao testar proxies"); }
    setBusy(false);
  }

  async function addProxy() {
    setBusy(true);
    try {
      const response = await fetch("/api/config/proxies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...proxyForm, port: Number(proxyForm.port) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setProxyForm({ id: "", host: "", port: "1080", username: "", password: "" });
      setNotice(`Proxy ${data.id} salvo somente neste computador`);
      await loadManager();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Falha ao cadastrar proxy"); }
    setBusy(false);
  }

  async function importWebshare() {
    if (!webshareToken.trim()) return setNotice("Cole a chave da API Webshare");
    setBusy(true);
    try {
      const response = await fetch("/api/config/webshare/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: webshareToken.trim() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setWebshareToken("");
      setNotice(`${data.imported} proxies Webshare importados para as próximas contas`);
      await loadManager(); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Falha ao importar Webshare"); }
    setBusy(false);
  }

  async function generateAccounts() {
    setBusy(true);
    try {
      const response = await fetch("/api/config/accounts/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...accountForm, start: Number(accountForm.start), count: Number(accountForm.count), pad: Number(accountForm.pad) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setAccountForm((form) => ({ ...form, password: "" }));
      setNotice(`${data.created.length} conta(s) sequenciais adicionadas`);
      await loadManager(); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Falha ao gerar contas"); }
    setBusy(false);
  }

  const realMarket = active?.market || [];
  const marketRows = realMarket.length
    ? realMarket.map((item) => ({ key: `slot-${item.slot}`, name: item.displayName, cost: item.lore.find((line) => /peixe/i.test(line)) || `slot ${item.slot}`, slot: item.slot, real: true }))
    : knownMarket.map((item) => ({ key: item.name, name: item.name, cost: item.cost, slot: item.slot, real: false }));

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">N</span><div><strong>Nerdzone</strong><small>Central local</small></div></div>
        <nav>
          <button className="nav-item active"><span>▦</span> Operação</button>
          <button className="nav-item" onClick={() => setAccountsPanelOpen(true)}><span>♟</span> Contas <b>{accounts.length}</b></button>
          <button className="nav-item" onClick={() => setFilter("todas")}><span>⌁</span> Automações</button>
          <button className="nav-item" onClick={() => setFilter("problema")}><span>▤</span> Registros {errors ? <b className="error-count">{errors}</b> : null}</button>
        </nav>
        <div className="server-card">
          <span className="eyebrow">SERVIÇOS LOCAIS</span>
          <strong><i className={apiOnline ? "" : "red-dot"} /> {apiOnline ? "Operacional" : "Desconectado"}</strong>
          <small>jogar.nerdzone.gg:30000</small>
          <div><span>Minecraft 1.8.9</span><span>{online}/{accounts.length}</span></div>
          <progress value={online} max={accounts.length || 1} />
        </div>
      </aside>

      <section className="content">
        <header>
          <div><p className="eyebrow">CENTRAL DE OPERAÇÃO</p><h1>Controle seus <em>bots</em></h1><p>Estado, inventário e comandos atualizados em tempo real.</p></div>
          <div className="header-tools"><button className="manager-button" onClick={openManager}>＋ Contas e proxies</button><div className="live-pill"><span className={apiOnline ? "live" : "dead"} /> {apiOnline ? "AO VIVO" : "SEM API"}</div></div>
        </header>

        <section className="stats-grid">
          <article><span className="stat-icon blue">♟</span><div><p>CONTAS CONFIGURADAS</p><strong>{accounts.length}<small>/∞</small></strong><span>{selected.length} selecionada(s)</span></div></article>
          <article><span className="stat-icon green">●</span><div><p>ONLINE AGORA</p><strong>{online}<small>/{accounts.length}</small></strong><span className="positive">{fishing} pescando</span></div></article>
          <article><span className="stat-icon violet">◈</span><div><p>SALDO TOTAL /PEIXES</p><strong>{knownBalances.length ? format(fish) : "—"}</strong><span>{knownBalances.length}/{accounts.length} saldos atualizados</span></div></article>
          <article><span className="stat-icon blue">↗</span><div><p>MÉDIA DE PESCA (ONLINE)</p><strong>{onlineRateAccounts.length ? `${format(Math.round(fishPerMinute))}/min` : "—"}</strong><span>{onlineRateAccounts.length ? `${format(Math.round(fishPerHour))}/hora · ${onlineRateAccounts.length} conta(s)` : "Aguardando duas leituras de /peixes"}</span></div></article>
          <article className={errors ? "featured clickable-stat" : "clickable-stat"} onClick={() => setFilter("problema")}><span className="stat-icon orange">!</span><div><p>CONTAS COM ERRO</p><strong>{errors}</strong><span>{errors ? "Clique para filtrar" : "Nenhum erro"}</span></div></article>
        </section>

        {triage.length > 0 && (
          <section className="error-triage">
            <div className="triage-head">
              <div><p className="eyebrow">TRIAGEM DE FALHAS</p><strong>{errors} conta(s) com problema, em {triage.length} causa(s)</strong></div>
              <div className="triage-tools"><button className="ghost" onClick={() => limparErros(true)}>Limpar erros antigos</button><button className="ghost" onClick={testProxies} disabled={busy}>Testar proxies</button></div>
            </div>
            {triage.map((group) => (
              <div className={`triage-row kind-${group.id}`} key={group.id}>
                <b>{group.members.length}</b>
                <div className="triage-copy">
                  <strong>{group.label}</strong>
                  <small>{group.advice}</small>
                  {group.proxies.length > 0 && <small className="triage-proxies">{group.proxies.length} proxy(s): {group.proxiesLabel}</small>}
                </div>
                <div className="triage-names">{group.namesLabel}</div>
                <button className="ghost" onClick={() => { setSelected(group.members.map((account) => account.id)); setNotice(`${group.members.length} conta(s) selecionada(s): ${group.label}`); }}>Selecionar</button>
                <button className="ghost" disabled={!group.retryable || busy} title={group.retryable ? "Roda o fluxo automático nestas contas" : "Reconectar não resolve este caso"} onClick={() => act(group.members.map((account) => account.id), "auto")}>Re-tentar</button>
              </div>
            ))}
            {proxyTest && (
              <div className="proxy-test-result">
                <strong>{proxyTest.healthy}/{proxyTest.tested} proxies responderam</strong>
                {proxyTest.results.filter((entry) => !entry.ok).map((entry) => <small key={entry.id}>✕ {entry.id} — {entry.error}</small>)}
              </div>
            )}
          </section>
        )}

        <section className="operations-panel">
          <div className="operation-head"><div><p className="eyebrow">AÇÕES EM LOTE</p><strong>{selected.length ? `${selected.length} conta(s) selecionada(s)` : "Selecione contas para liberar as ações"}</strong><small className="selection-help">Clique nas linhas ou use Shift para selecionar um intervalo.</small></div><div className="selection-tools"><button className="ghost" onClick={selectVisible} disabled={!visible.length}>Selecionar visíveis ({visible.length})</button><button className="ghost" onClick={clearSelection} disabled={!selected.length}>Limpar</button></div></div>
          <div className="action-guide"><span><b>1</b><strong>Conectar</strong><small>entrar no servidor</small></span><span><b>2</b><strong>Preparar</strong><small>RankUP e kit</small></span><span><b>3</b><strong>Operar</strong><small>plot, pesca e mercado</small></span><span><b>4</b><strong>Encerrar</strong><small>pausar ou desconectar</small></span></div>
          <div className="operation-buttons">
            <button disabled={busy || !selected.length} className="success" onClick={() => act(targets, "connect")}>● Conectar</button>
            <button disabled={busy || !selected.length} className="auto-button" title={selected.length ? "Executar o fluxo completo nas contas selecionadas" : "Selecione as contas primeiro"} onClick={() => act(selected, "auto")}>▶ Automático selecionadas</button>
            <button disabled={busy || !selected.length} onClick={() => act(targets, "rankup")}>◆ Entrar RankUP</button>
            <button disabled={busy || !selected.length} onClick={() => act(targets, "kit")}>Kit iniciante</button>
            <button disabled={busy || !selected.length} onClick={() => act(targets, "plot")}>⌂ Ir ao plot</button>
            <button disabled={busy || !selected.length} className="violet-button" onClick={() => act(targets, "fish")}>♟ Iniciar pesca</button>
            <button disabled={busy || !balanceTargets.length} onClick={() => act(balanceTargets, "balance")}>Atualizar peixes</button>
            <button disabled={busy || !selected.length} onClick={() => act(targets, "pause")}>Ⅱ Pausar</button>
            <button disabled={busy || !selected.length} onClick={() => act(targets, "market")}>$ Abrir mercado</button>
            <button disabled={busy || !selected.length} className="danger" onClick={() => { if (window.confirm(`Desconectar ${selected.length} conta(s)?`)) act(targets, "disconnect"); }}>■ Desconectar</button>
          </div>
          <div className="batch-connect"><div><strong>Conectar por lote</strong><span>Todas protegidas por um proxy</span></div><label>Proxy<select value={batchProxy} onChange={(event) => setBatchProxy(event.target.value)}><option value="auto">Automático: grupo com vagas</option>{[...new Set(accounts.map((account) => account.proxyId).filter((value): value is string => Boolean(value)))].map((proxyId) => <option key={proxyId} value={proxyId}>{proxyId}</option>)}</select></label><label>Quantidade<input type="number" min="1" value={batchCount} onChange={(event) => setBatchCount(event.target.value)} /></label><button disabled={busy} onClick={connectBatch}>Conectar lote</button></div>
          <div className={`automation-runner ${groupAutomation?.running ? "running" : ""}`}>
            <div className="automation-copy"><span className="eyebrow">AUTOMÁTICO EM FILA</span><strong>Uma conta por vez, na ordem da lista</strong><small>Conecta, autentica, entra no RankUP, prepara a vara quando necessário e começa a pescar. Só passa para a próxima quando a atual termina — conectar em rajada marca o IP no servidor.</small></div>
            <div className="automation-status"><span>{groupAutomation?.running ? "EM EXECUÇÃO" : "PARADO"}</span><strong>{groupAutomation?.message || "Pronto para iniciar"}</strong>{groupAutomation?.currentGroup && <small>Proxy: {groupAutomation.currentGroup}</small>}{groupAutomation?.failedAccounts.length ? <small className="automation-failures">Falhas atuais: {groupAutomation.failedAccounts.map((failure) => failure.username).join(", ")}</small> : null}{groupAutomation?.nextGroupAt && <small>Próximo grupo às {new Date(groupAutomation.nextGroupAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small>}</div>
            <div className="automation-progress"><span>{groupAutomation?.completedGroups.length || 0} conta(s) conectada(s)</span>{groupAutomation?.currentAccounts.length ? <small>{groupAutomation.currentAccounts.join(", ")}</small> : <small>Intervalo entre contas: 5 segundos</small>}</div>
            <button className={groupAutomation?.running ? "stop-automation" : "start-automation"} disabled={busy} onClick={() => controlGroupAutomation(groupAutomation?.running ? "stop" : "start")}>{groupAutomation?.running ? "Parar fila" : "Iniciar todos aos poucos"}</button>
          </div>
          <div className="global-command">
            <div className="command-target">{selected.length ? `${selected.length} selecionada(s)` : "Nenhuma conta selecionada"}</div>
            <input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === "Enter" && sendCommand()} placeholder="Digite /spawn, /saldo, mensagem..." disabled={!selected.length} />
            <button onClick={sendCommand} disabled={!selected.length || !command.trim()}>Enviar comando em lote</button>
          </div>
        </section>

        <section className="accounts-section">
          <div className="section-heading"><div><h2>Contas</h2><span>{visible.length} exibida(s) · {selected.length} selecionada(s)</span></div><div className="filters"><label>⌕<input aria-label="Buscar conta" placeholder="Buscar nick..." value={query} onChange={(event) => setQuery(event.target.value)} /></label>{(["todas", "online", "pescando", "offline", "problema"] as const).map((item) => <button key={item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)}>{item === "problema" ? "Problemas" : item[0].toUpperCase() + item.slice(1)}</button>)}</div></div>
          {!loaded ? <p className="table-empty">Carregando contas do serviço local...</p>
            : !accounts.length ? <p className="table-empty">Nenhuma conta cadastrada. Use “Contas e proxies” para adicionar.</p>
            : !visible.length ? <p className="table-empty">Nenhuma conta corresponde ao filtro.</p>
            : (
              <div className="account-table-wrap">
                <table className="account-table">
                  <thead>
                    <tr>
                      <th className="col-check"><input type="checkbox" aria-label="Selecionar visíveis" checked={visible.length > 0 && visible.every((account) => selected.includes(account.id))} onChange={(event) => event.target.checked ? selectVisible() : clearSelection()} /></th>
                      <th>Conta</th><th>Atividade</th><th>Local</th><th>Saldo</th><th>Itens</th><th>Proxy</th><th>Última mensagem / erro</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        checked={selected.includes(account.id)}
                        busy={pending.includes(account.id)}
                        onSelect={selectAccount}
                        onOpen={openAccount}
                        onAction={actOne}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      </section>

      {accountsPanelOpen && <div className="modal-backdrop" onMouseDown={() => setAccountsPanelOpen(false)}><section className="account-directory" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><p className="eyebrow">CENTRAL DE CONTAS</p><h2>Todas as contas e registros</h2><span className="status-line">{accounts.length} contas · {accounts.filter((account) => account.registered).length} registradas · {errors} com problema</span></div><button onClick={() => setAccountsPanelOpen(false)}>×</button></div>
        <div className="directory-toolbar"><input value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder="Buscar conta ou nick..." /><button onClick={() => { setAccountsPanelOpen(false); setFilter("problema"); }}>Ver problemas</button></div>
        <div className="directory-list">{registryVisible.map((account) => <button className="directory-row" key={account.id} onClick={() => { setAccountsPanelOpen(false); setActiveId(account.id); }}><span className={`directory-dot ${account.status}`} /><strong>{account.username}</strong><span>{account.proxyId || "IP residencial"}</span><span className={account.registered ? "registered" : "pending"}>{account.registered ? "Registrada" : "Pendente"}</span><span>{account.activity}</span><b>{balanceDisplay(account)}</b><small>{account.lastError || account.lastMessage || "Sem registro nesta sessão"}</small></button>)}</div>
      </section></div>}
      {active && <div className="modal-backdrop" onMouseDown={() => setActiveId(null)}><section className="account-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><p className="eyebrow">CONTA</p><h2>{active.username}</h2><span className={`status-line ${active.status}`}>{active.status} · {active.activity}</span></div><button onClick={() => setActiveId(null)}>×</button></div>
        <div className="modal-summary"><div><span>Saldo /peixes</span><strong title={balanceHint(active)}>{balanceDisplay(active)}</strong></div><div><span>Saldo atualizado</span><strong>{active.balanceUpdatedAt ? new Date(active.balanceUpdatedAt).toLocaleTimeString("pt-BR") : "Aguardando"}</strong></div><div><span>Registro</span><strong>{active.registered ? "Confirmado" : "Pendente"}</strong></div><div><span>Itens</span><strong>{active.itemCount ?? active.inventory.reduce((sum, item) => sum + item.count, 0)}</strong></div></div>
        {(active.lastError || active.blockedReason) && <div className="modal-error"><strong>{active.blocked ? "Bloqueado pelo servidor" : "Erro atual"}</strong><p>{active.lastError || active.blockedReason}</p></div>}
        <div className="modal-actions"><button onClick={() => act([active.id], "kit")}>Kit iniciante</button><button onClick={() => act([active.id], "plot")}>Ir ao plot</button><button onClick={() => act([active.id], "fish")}>Iniciar pesca</button><button onClick={() => act([active.id], "market")}>Abrir mercado</button><button className="danger-action" onClick={() => act([active.id], "disconnect")}>Desconectar</button></div>
        <div className="modal-workspace">
          <section className="inventory-pane"><div className="market-title"><h3>Inventário em tempo real</h3><button className="drop-all" onClick={() => { if (window.confirm(`Dropar TODOS os itens de ${active.username}?`)) act([active.id], "dropall"); }}>Dropar tudo</button></div><div className="inventory-list">{active.inventory.length ? active.inventory.map((item) => <div key={`${item.name}:${item.metadata}`}><div><strong>{item.displayName}</strong><span>{item.hotbarSlots.length ? `Hotbar: ${item.hotbarSlots.join(", ")}${item.outsideHotbar ? " · também no inventário" : ""}` : "Não está na hotbar"}</span></div><b>{item.count}</b><button onClick={() => act([active.id], "drop", { itemName: item.name, count: item.count })}>Dropar</button></div>) : <p>Inventário vazio.</p>}</div></section>
          <section className="chat-panel"><div className="chat-head"><div><i className={active.status === "online" ? "" : "red-dot"} /><strong>Chat ao vivo</strong></div><span>{active.chatMessages?.length || 0}/30</span></div><div className="chat-messages">{active.chatMessages?.length ? active.chatMessages.map((message, index) => <div className={message.direction === "out" ? "chat-message sent" : "chat-message"} key={`${message.at}:${index}`}><span>{message.direction === "out" ? "Você" : new Date(message.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><p>{message.text}</p></div>) : <div className="chat-empty"><strong>Nenhuma mensagem nesta sessão</strong><span>O chat aparecerá aqui em tempo real.</span></div>}</div><div className="chat-compose"><input value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && sendActiveChat()} placeholder="Mensagem ou /comando..." disabled={active.status !== "online"} /><button onClick={sendActiveChat} disabled={active.status !== "online" || !chatDraft.trim()}>Enviar</button></div></section>
        </div>
        <div className="market-title"><h3>Mercado de Pesca</h3><button onClick={() => act([active.id], "market")}>Atualizar menu</button></div>
        {!realMarket.length && <p className="market-warning">⚠ Mostrando a tabela de slots salva no painel. Clique em “Atualizar menu” para ler o mercado real antes de comprar.</p>}
        <div className="purchase-quantity"><label>Quantidade por compra<input type="number" min="1" max="2304" value={purchaseQuantity} onChange={(event) => setPurchaseQuantity(event.target.value)} /></label><span>Os itens ficam no inventário da conta. Nada será levado ao plot.</span></div>
        <div className="market-grid">{marketRows.map((item) => <div className={item.real ? "" : "known-item"} key={item.key}><div><strong>{item.name}</strong><span>{item.cost} · slot {item.slot}</span></div><button onClick={() => act([active.id], "purchase", { slot: item.slot })}>Comprar</button></div>)}</div>
      </section></div>}
      {managerOpen && <div className="modal-backdrop" onMouseDown={() => setManagerOpen(false)}><section className="account-modal manager-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><p className="eyebrow">CONFIGURAÇÃO LOCAL</p><h2>Contas e proxies</h2><span className="status-line">Nenhuma senha é exibida pela API</span></div><button onClick={() => setManagerOpen(false)}>×</button></div>
        <div className="privacy-note">🔒 Tudo é armazenado somente neste computador. Use proxies SOCKS5 privados e confiáveis.</div>
        <section className="webshare-import"><div><h3>Importar da Webshare</h3><p>Contas novas usam proxy obrigatoriamente, até 10 por endereço. As 9 contas vulkspesca permanecem no IP local.</p></div><input type="password" value={webshareToken} onChange={(event) => setWebshareToken(event.target.value)} placeholder="API Key da Webshare" autoComplete="new-password" /><button disabled={busy} onClick={importWebshare}>Importar proxies</button><a href="https://dashboard.webshare.io/userapi/keys" target="_blank" rel="noreferrer">Abrir página de API Keys</a></section>
        <div className="manager-columns">
          <section><h3>Adicionar proxy SOCKS5</h3><div className="form-grid"><label>Nome<input value={proxyForm.id} onChange={(event) => setProxyForm({ ...proxyForm, id: event.target.value })} placeholder="proxy-casa-2" /></label><label>Host/IP<input value={proxyForm.host} onChange={(event) => setProxyForm({ ...proxyForm, host: event.target.value })} placeholder="proxy.exemplo.com" /></label><label>Porta<input value={proxyForm.port} onChange={(event) => setProxyForm({ ...proxyForm, port: event.target.value })} /></label><label>Usuário<input value={proxyForm.username} onChange={(event) => setProxyForm({ ...proxyForm, username: event.target.value })} autoComplete="off" /></label><label>Senha<input type="password" value={proxyForm.password} onChange={(event) => setProxyForm({ ...proxyForm, password: event.target.value })} autoComplete="new-password" /></label></div><button className="form-submit" disabled={busy} onClick={addProxy}>Salvar proxy</button></section>
          <section><h3>Gerar nicks sequenciais</h3><div className="form-grid"><label>Nome base<input value={accountForm.baseName} onChange={(event) => setAccountForm({ ...accountForm, baseName: event.target.value })} placeholder="minhaconta" /></label><label>Primeiro número<input type="number" value={accountForm.start} onChange={(event) => setAccountForm({ ...accountForm, start: event.target.value })} /></label><label>Quantidade<input type="number" min="1" value={accountForm.count} onChange={(event) => setAccountForm({ ...accountForm, count: event.target.value })} /></label><label>Dígitos<input type="number" min="0" max="4" value={accountForm.pad} onChange={(event) => setAccountForm({ ...accountForm, pad: event.target.value })} /></label><label>Senha /logar<input type="password" value={accountForm.password} onChange={(event) => setAccountForm({ ...accountForm, password: event.target.value })} autoComplete="new-password" /></label><label>Tipo de conexão<select value={accountForm.connectionMode} onChange={(event) => setAccountForm({ ...accountForm, connectionMode: event.target.value })}><option value="local">Meu IP residencial</option><option value="proxy">Proxy autenticada</option></select></label>{accountForm.connectionMode === "proxy" && <label>Proxy<select value={accountForm.proxyId} onChange={(event) => setAccountForm({ ...accountForm, proxyId: event.target.value })}><option value="auto">Automática (até 10 por proxy)</option>{manager?.proxies.filter((proxy) => proxy.username).map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.id} · {proxy.usage}/{manager.maxPerProxy}</option>)}</select></label>}</div><button className="form-submit" disabled={busy} onClick={generateAccounts}>Gerar e adicionar</button></section>
        </div>
        <div className="market-title"><h3>Distribuição atual</h3><button onClick={testProxies} disabled={busy}>Testar proxies em uso</button></div>
        {proxyTest && <div className="proxy-test-result"><strong>{proxyTest.healthy}/{proxyTest.tested} proxies responderam</strong>{proxyTest.results.filter((entry) => !entry.ok).map((entry) => <small key={entry.id}>✕ {entry.id} — {entry.error}</small>)}</div>}
        <div className="proxy-list">{manager?.proxies.length ? manager.proxies.map((proxy) => <div key={proxy.id}><strong>{proxy.id}</strong><span>{proxy.host}:{proxy.port}</span><b>{proxy.usage}/{manager.maxPerProxy} contas</b></div>) : <p>Nenhum proxy cadastrado. Contas novas não poderão ser criadas ou conectadas.</p>}</div>
        <div className="capacity-line"><span>{manager?.accounts.length || 0} contas cadastradas</span><strong>Sem limite global · {manager?.maxPerProxy || 10} por proxy</strong></div>
      </section></div>}
      <div className="toast"><i className={apiOnline ? "" : "red-dot"} /> {notice}</div>
    </main>
  );
}
