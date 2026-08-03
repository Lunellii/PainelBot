"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Item = { name: string; displayName: string; count: number; metadata: number; hotbarSlots: number[]; outsideHotbar: boolean };
type MarketItem = { slot: number; name: string; displayName: string; count: number; lore: string[] };
type ChatMessage = { at: string; text: string; direction: "in" | "out" };
type ManagerConfig = { maxAccounts: number | null; maxPerProxy: number; accounts: Array<{ id: string; username: string; proxyId: string | null }>; proxies: Array<{ id: string; host: string; port: number; username: string | null; usage: number }> };
type AutomationStatus = { running: boolean; startedAt: string | null; currentGroup: string | null; currentAccounts: string[]; completedGroups: string[]; failedAccounts: Array<{ username: string; error: string }>; nextGroupAt: string | null; message: string };
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
  inventory: Item[];
  market?: MarketItem[];
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  chatMessages?: ChatMessage[];
  lastError?: string | null;
  purchaseNotice?: string | null;
  connectedAt?: string | null;
  automationRunning?: boolean;
  registered?: boolean;
  balancePending?: boolean;
  balanceError?: string | null;
  balanceStatus?: "atualizado" | "desatualizado" | "atualizando" | "erro" | "sem_dados";
};

const names = ["vulkspesca", "vulkspesca02", "vulkspesca03", "vulkspesca04", "vulkspesca05", "vulkspesca06", "vulkspesca07", "vulkspesca08", "vulkspesca09"];
const fallback: Account[] = names.map((username) => ({ id: username, username, status: "offline", activity: "parado", fishCount: 0, inventory: [] }));
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

export default function Home() {
  const [accounts, setAccounts] = useState<Account[]>(fallback);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [filter, setFilter] = useState<"todas" | "online" | "pescando" | "offline" | "problema">("todas");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("Conectando ao serviço local...");
  const [apiOnline, setApiOnline] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [batchCount, setBatchCount] = useState("10");
  const [batchProxy, setBatchProxy] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [manager, setManager] = useState<ManagerConfig | null>(null);
  const [proxyForm, setProxyForm] = useState({ id: "", host: "", port: "1080", username: "", password: "" });
  const [accountForm, setAccountForm] = useState({ baseName: "", start: "1", count: "1", pad: "2", password: "", connectionMode: "proxy", proxyId: "auto" });
  const [webshareToken, setWebshareToken] = useState("");
  const [groupAutomation, setGroupAutomation] = useState<AutomationStatus | null>(null);
  const [accountsPanelOpen, setAccountsPanelOpen] = useState(false);
  const [registryQuery, setRegistryQuery] = useState("");
  const [purchaseQuantity, setPurchaseQuantity] = useState("1");

  const refresh = useCallback(async () => {
    try {
      const [response, automationResponse] = await Promise.all([
        fetch("/api/accounts", { cache: "no-store" }),
        fetch("/api/automation/status", { cache: "no-store" }),
      ]);
      if (!response.ok) throw new Error("Serviço dos bots indisponível");
      setAccounts(await response.json());
      if (automationResponse.ok) setGroupAutomation(await automationResponse.json());
      setApiOnline(true);
    } catch {
      setApiOnline(false);
      setNotice("Serviço dos bots desconectado");
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const visible = useMemo(() => accounts.filter((account) => {
    const text = account.username.toLowerCase().includes(query.toLowerCase());
    const match = filter === "todas" || account.status === filter || (filter === "pescando" && account.activity === "pescando") || (filter === "problema" && Boolean(account.lastError));
    return text && match;
  }), [accounts, query, filter]);
  const active = accounts.find((account) => account.id === activeId) || null;
  const online = accounts.filter((account) => account.status === "online").length;
  const fishing = accounts.filter((account) => account.activity === "pescando").length;
  const errors = accounts.filter((account) => account.lastError).length;
  const knownBalances = accounts.filter((account) => account.balanceUpdatedAt);
  const fish = knownBalances.reduce((sum, account) => sum + account.fishCount, 0);
  const onlineRateAccounts = accounts.filter((account) => account.status === "online");
  const fishPerMinute = onlineRateAccounts.reduce((sum, account) => sum + (Number(account.fishPerMinute) || 0), 0);
  const fishPerHour = fishPerMinute * 60;
  const balanceTargets = accounts.filter((account) => selected.includes(account.id) && account.status === "online").map((account) => account.id);
  const registryVisible = useMemo(() => accounts.filter((account) => account.username.toLowerCase().includes(registryQuery.toLowerCase())), [accounts, registryQuery]);

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

  async function act(ids: string[], action: string, body?: object) {
    if (!ids.length) return setNotice("Selecione pelo menos uma conta");
    setBusy(true);
    setNotice(`Executando ${action} em ${ids.length} conta(s)...`);
    const effectiveBody = action === "purchase" ? { ...(body || {}), quantity: Math.max(1, Number(purchaseQuantity) || 1) } : body;
    const results = await Promise.allSettled(ids.map((id) => request(id, action, effectiveBody)));
    const failed = results.filter((result) => result.status === "rejected");
    setNotice(failed.length ? `${results.length - failed.length} concluída(s), ${failed.length} falharam` : `Comando executado em ${ids.length} conta(s)`);
    if (action === "purchase") {
      const purchaseResult = results.find((result): result is PromiseFulfilledResult<Account> => result.status === "fulfilled" && Boolean(result.value.purchaseNotice));
      if (purchaseResult) setNotice(purchaseResult.value.purchaseNotice as string);
    }
    setBusy(false);
    window.setTimeout(refresh, 500);
  }

  const targets = selected;

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
      try { await request(account.id, "connect"); connected += 1; } catch {}
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

        <section className="operations-panel">
          <div className="operation-head"><div><p className="eyebrow">AÇÕES EM LOTE</p><strong>{selected.length ? `${selected.length} conta(s) selecionada(s)` : "Selecione contas para liberar as ações"}</strong><small className="selection-help">Clique nas contas ou use Shift para selecionar um intervalo.</small></div><div className="selection-tools"><button className="ghost" onClick={selectVisible} disabled={!visible.length}>Selecionar visíveis ({visible.length})</button><button className="ghost" onClick={clearSelection} disabled={!selected.length}>Limpar</button></div></div>
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
            <button disabled={busy || !selected.length} className="danger" onClick={() => act(targets, "disconnect")}>■ Desconectar-se</button>
          </div>
          <div className="batch-connect"><div><strong>Conectar por lote</strong><span>Todas protegidas por um proxy</span></div><label>Proxy<select value={batchProxy} onChange={(event) => setBatchProxy(event.target.value)}><option value="auto">Automático: grupo com vagas</option>{[...new Set(accounts.map((account) => account.proxyId).filter((value): value is string => Boolean(value)))].map((proxyId) => <option key={proxyId} value={proxyId}>{proxyId}</option>)}</select></label><label>Quantidade<input type="number" min="1" value={batchCount} onChange={(event) => setBatchCount(event.target.value)} /></label><button disabled={busy} onClick={connectBatch}>Conectar lote</button></div>
          <div className={`automation-runner ${groupAutomation?.running ? "running" : ""}`}>
            <div className="automation-copy"><span className="eyebrow">AUTOMÁTICO POR GRUPOS</span><strong>10 contas do mesmo IP/proxy por vez</strong><small>Conecta, autentica, entra no RankUP, prepara a vara quando necessário, começa a pescar e só avança após validar o grupo.</small></div>
            <div className="automation-status"><span>{groupAutomation?.running ? "EM EXECUÇÃO" : "PARADO"}</span><strong>{groupAutomation?.message || "Pronto para iniciar"}</strong>{groupAutomation?.currentGroup && <small>Grupo: {groupAutomation.currentGroup} · {groupAutomation.currentAccounts.length} contas</small>}{groupAutomation?.failedAccounts.length ? <small className="automation-failures">Falhas atuais: {groupAutomation.failedAccounts.map((failure) => failure.username).join(", ")}</small> : null}{groupAutomation?.nextGroupAt && <small>Próximo grupo às {new Date(groupAutomation.nextGroupAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small>}</div>
            <div className="automation-progress"><span>{groupAutomation?.completedGroups.length || 0} grupo(s) concluído(s)</span>{groupAutomation?.currentAccounts.length ? <small>{groupAutomation.currentAccounts.join(", ")}</small> : <small>Intervalo entre grupos: 2 minutos</small>}</div>
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
          <div className="account-grid">
            {visible.map((account) => (
              <article className={`account-card ${selected.includes(account.id) ? "checked" : ""}`} key={account.id}>
                <div className="card-top" onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input, label")) selectAccount(account.id, event.shiftKey); }}><label className="check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected.includes(account.id)} onChange={(event) => selectAccount(account.id, event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)} /><span /></label><div className="avatar">{account.username.slice(0, 2).toUpperCase()}</div><div className="identity"><strong>{account.username}</strong><span className={account.status}>{account.status}</span></div><button className="more" onClick={() => setActiveId(account.id)}>Detalhes</button></div>
                <div className="activity"><span className={account.activity === "pescando" ? "pulse" : "idle"}>♟</span><div><small>ATIVIDADE REAL</small><strong>{account.automationRunning ? `Automático · ${account.activity}` : account.activity}</strong><small className="location-label">Local: {account.location === "rankup" ? "RankUP" : account.location === "lobby" ? "Lobby" : account.location === "pesca" ? "Pesca" : account.location || "Desconhecido"}</small></div><span className="timer">Saldo: {balanceDisplay(account)}</span></div>
                <div className="metrics real-metrics"><div><span>Inventário</span><strong>{account.inventory.reduce((sum, item) => sum + item.count, 0)} <small>itens</small></strong></div><div><span>Saldo /peixes</span><strong className={`gold balance-${account.balanceStatus || "sem_dados"}`} title={balanceHint(account)}>{balanceDisplay(account)}</strong></div><div className="wide-metric"><span>Última mensagem {account.lastMessageAt ? `· ${new Date(account.lastMessageAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : ""}</span><strong title={account.lastMessage || ""}>{account.lastMessage || "—"}</strong></div></div>
                {account.lastError && <div className="account-error">! {account.lastError}</div>}
                <div className="card-actions compact-actions">
                  <button className={account.status === "offline" ? "connect" : ""} onClick={() => act([account.id], account.status === "offline" ? "connect" : account.activity === "pescando" ? "pause" : "fish")}>{account.status === "offline" ? "Conectar" : account.activity === "pescando" ? "Pausar" : "Pescar"}</button>
                  <button onClick={() => act([account.id], "kit")}>Kit iniciante</button><button onClick={() => act([account.id], "plot")}>Plot</button><button onClick={() => setActiveId(account.id)}>Inventário</button><button onClick={() => act([account.id], "market")}>Mercado</button><button onClick={() => act([account.id], "disconnect")}>Desconectar-se</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>

      {accountsPanelOpen && <div className="modal-backdrop" onMouseDown={() => setAccountsPanelOpen(false)}><section className="account-directory" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><p className="eyebrow">CENTRAL DE CONTAS</p><h2>Todas as contas e registros</h2><span className="status-line">{accounts.length} contas · {accounts.filter((account) => account.registered).length} registradas · {errors} com problema</span></div><button onClick={() => setAccountsPanelOpen(false)}>×</button></div>
        <div className="directory-toolbar"><input value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder="Buscar conta ou nick..." /><button onClick={() => { setAccountsPanelOpen(false); setFilter("problema"); }}>Ver problemas</button></div>
        <div className="directory-list">{registryVisible.map((account) => <button className="directory-row" key={account.id} onClick={() => { setAccountsPanelOpen(false); setActiveId(account.id); }}><span className={`directory-dot ${account.status}`} /><strong>{account.username}</strong><span>{account.proxyId || "IP residencial"}</span><span className={account.registered ? "registered" : "pending"}>{account.registered ? "Registrada" : "Pendente"}</span><span>{account.activity}</span><b>{balanceDisplay(account)}</b><small>{account.lastError || account.lastMessage || "Sem registro nesta sessão"}</small></button>)}</div>
      </section></div>}
      {active && <div className="modal-backdrop" onMouseDown={() => setActiveId(null)}><section className="account-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><p className="eyebrow">CONTA</p><h2>{active.username}</h2><span className={`status-line ${active.status}`}>{active.status} · {active.activity}</span></div><button onClick={() => setActiveId(null)}>×</button></div>
        <div className="modal-summary"><div><span>Saldo /peixes</span><strong title={balanceHint(active)}>{balanceDisplay(active)}</strong></div><div><span>Saldo atualizado</span><strong>{active.balanceUpdatedAt ? new Date(active.balanceUpdatedAt).toLocaleTimeString("pt-BR") : "Aguardando"}</strong></div><div><span>Registro</span><strong>{active.registered ? "Confirmado" : "Pendente"}</strong></div><div><span>Itens</span><strong>{active.inventory.reduce((sum, item) => sum + item.count, 0)}</strong></div></div>
        <div className="modal-actions"><button onClick={() => act([active.id], "kit")}>Kit iniciante</button><button onClick={() => act([active.id], "plot")}>Ir ao plot</button><button onClick={() => act([active.id], "fish")}>Iniciar pesca</button><button onClick={() => act([active.id], "market")}>Abrir mercado</button><button className="danger-action" onClick={() => act([active.id], "disconnect")}>Desconectar-se</button></div>
        <div className="modal-workspace">
          <section className="inventory-pane"><div className="market-title"><h3>Inventário em tempo real</h3><button className="drop-all" onClick={() => { if (window.confirm(`Dropar TODOS os itens de ${active.username}?`)) act([active.id], "dropall"); }}>Dropar tudo</button></div><div className="inventory-list">{active.inventory.length ? active.inventory.map((item) => <div key={`${item.name}:${item.metadata}`}><div><strong>{item.displayName}</strong><span>{item.hotbarSlots.length ? `Hotbar: ${item.hotbarSlots.join(", ")}${item.outsideHotbar ? " · também no inventário" : ""}` : "Não está na hotbar"}</span></div><b>{item.count}</b><button onClick={() => act([active.id], "drop", { itemName: item.name, count: item.count })}>Dropar</button></div>) : <p>Inventário vazio.</p>}</div></section>
          <section className="chat-panel"><div className="chat-head"><div><i className={active.status === "online" ? "" : "red-dot"} /><strong>Chat ao vivo</strong></div><span>{active.chatMessages?.length || 0}/30</span></div><div className="chat-messages">{active.chatMessages?.length ? active.chatMessages.map((message, index) => <div className={message.direction === "out" ? "chat-message sent" : "chat-message"} key={`${message.at}:${index}`}><span>{message.direction === "out" ? "Você" : new Date(message.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><p>{message.text}</p></div>) : <div className="chat-empty"><strong>Nenhuma mensagem nesta sessão</strong><span>O chat aparecerá aqui em tempo real.</span></div>}</div><div className="chat-compose"><input value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && sendActiveChat()} placeholder="Mensagem ou /comando..." disabled={active.status !== "online"} /><button onClick={sendActiveChat} disabled={active.status !== "online" || !chatDraft.trim()}>Enviar</button></div>{active.lastError && <div className="chat-error"><strong>Erro atual</strong><span>{active.lastError}</span></div>}</section>
        </div>
        <div className="market-title"><h3>Mercado de Pesca</h3><button onClick={() => act([active.id], "market")}>Atualizar menu</button></div>
        <div className="purchase-quantity"><label>Quantidade por compra<input type="number" min="1" max="2304" value={purchaseQuantity} onChange={(event) => setPurchaseQuantity(event.target.value)} /></label><span>Os itens ficam no inventário da conta. Nada será levado ao plot.</span></div>
        <div className="market-grid">{knownMarket.map((item) => <div key={item.name}><div><strong>{item.name}</strong><span>{item.cost} · slot {item.slot}</span></div><button onClick={() => act([active.id], "purchase", { slot: item.slot })}>Comprar e entregar</button></div>)}</div>
      </section></div>}
      {managerOpen && <div className="modal-backdrop" onMouseDown={() => setManagerOpen(false)}><section className="account-modal manager-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><p className="eyebrow">CONFIGURAÇÃO LOCAL</p><h2>Contas e proxies</h2><span className="status-line">Nenhuma senha é exibida pela API</span></div><button onClick={() => setManagerOpen(false)}>×</button></div>
        <div className="privacy-note">🔒 Tudo é armazenado somente neste computador. Use proxies SOCKS5 privados e confiáveis.</div>
        <section className="webshare-import"><div><h3>Importar da Webshare</h3><p>Contas novas usam proxy obrigatoriamente, até 10 por endereço. As 9 contas vulkspesca permanecem no IP local.</p></div><input type="password" value={webshareToken} onChange={(event) => setWebshareToken(event.target.value)} placeholder="API Key da Webshare" autoComplete="new-password" /><button disabled={busy} onClick={importWebshare}>Importar proxies</button><a href="https://dashboard.webshare.io/userapi/keys" target="_blank" rel="noreferrer">Abrir página de API Keys</a></section>
        <div className="manager-columns">
          <section><h3>Adicionar proxy SOCKS5</h3><div className="form-grid"><label>Nome<input value={proxyForm.id} onChange={(event) => setProxyForm({ ...proxyForm, id: event.target.value })} placeholder="proxy-casa-2" /></label><label>Host/IP<input value={proxyForm.host} onChange={(event) => setProxyForm({ ...proxyForm, host: event.target.value })} placeholder="proxy.exemplo.com" /></label><label>Porta<input value={proxyForm.port} onChange={(event) => setProxyForm({ ...proxyForm, port: event.target.value })} /></label><label>Usuário<input value={proxyForm.username} onChange={(event) => setProxyForm({ ...proxyForm, username: event.target.value })} autoComplete="off" /></label><label>Senha<input type="password" value={proxyForm.password} onChange={(event) => setProxyForm({ ...proxyForm, password: event.target.value })} autoComplete="new-password" /></label></div><button className="form-submit" disabled={busy} onClick={addProxy}>Salvar proxy</button></section>
          <section><h3>Gerar nicks sequenciais</h3><div className="form-grid"><label>Nome base<input value={accountForm.baseName} onChange={(event) => setAccountForm({ ...accountForm, baseName: event.target.value })} placeholder="minhaconta" /></label><label>Primeiro número<input type="number" value={accountForm.start} onChange={(event) => setAccountForm({ ...accountForm, start: event.target.value })} /></label><label>Quantidade<input type="number" min="1" value={accountForm.count} onChange={(event) => setAccountForm({ ...accountForm, count: event.target.value })} /></label><label>Dígitos<input type="number" min="0" max="4" value={accountForm.pad} onChange={(event) => setAccountForm({ ...accountForm, pad: event.target.value })} /></label><label>Senha /logar<input type="password" value={accountForm.password} onChange={(event) => setAccountForm({ ...accountForm, password: event.target.value })} autoComplete="new-password" /></label><label>Tipo de conexão<select value={accountForm.connectionMode} onChange={(event) => setAccountForm({ ...accountForm, connectionMode: event.target.value })}><option value="local">Meu IP residencial</option><option value="proxy">Proxy autenticada</option></select></label>{accountForm.connectionMode === "proxy" && <label>Proxy<select value={accountForm.proxyId} onChange={(event) => setAccountForm({ ...accountForm, proxyId: event.target.value })}><option value="auto">Automática (até 10 por proxy)</option>{manager?.proxies.filter((proxy) => proxy.username).map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.id} · {proxy.usage}/{manager.maxPerProxy}</option>)}</select></label>}</div><button className="form-submit" disabled={busy} onClick={generateAccounts}>Gerar e adicionar</button></section>
        </div>
        <h3>Distribuição atual</h3><div className="proxy-list">{manager?.proxies.length ? manager.proxies.map((proxy) => <div key={proxy.id}><strong>{proxy.id}</strong><span>{proxy.host}:{proxy.port}</span><b>{proxy.usage}/{manager.maxPerProxy} contas</b></div>) : <p>Nenhum proxy cadastrado. Contas novas não poderão ser criadas ou conectadas.</p>}</div>
        <div className="capacity-line"><span>{manager?.accounts.length || 0} contas cadastradas</span><strong>Sem limite global · {manager?.maxPerProxy || 10} por proxy</strong></div>
      </section></div>}
      <div className="toast"><i className={apiOnline ? "" : "red-dot"} /> {notice}</div>
    </main>
  );
}
