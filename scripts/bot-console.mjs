import readline from "node:readline";

const base = "http://127.0.0.1:3000/api";

async function api(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Erro HTTP ${response.status}`);
  return data;
}

async function accounts() { return api("/accounts"); }
async function targets(name) {
  const list = await accounts();
  if (name === "todas" || name === "todos") return list;
  const account = list.find((item) => item.id.toLowerCase() === name.toLowerCase() || item.username.toLowerCase() === name.toLowerCase());
  if (!account) throw new Error(`Conta não encontrada: ${name}`);
  return [account];
}

async function action(name, command, body) {
  const selected = await targets(name);
  for (const account of selected) {
    try {
      await api(`/accounts/${encodeURIComponent(account.id)}/${command}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      console.log(`  OK  ${account.username}`);
    } catch (error) {
      console.log(`  ERRO ${account.username}: ${error.message}`);
    }
  }
}

function help() {
  console.log(`
COMANDOS
  status
  conectar todas
  conectar vulkspesca
  desconectar todas
  pescar todas
  pausar todas
  plot todas
  mercado vulkspesca
  inventario vulkspesca
  comando todas /spawn
  comando vulkspesca /saldo
  dropar vulkspesca raw_fish 64
  dropar-tudo vulkspesca
  ajuda
  sair
`);
}

async function run(line) {
  const input = line.trim();
  if (!input) return;
  const [command, name = "todas", ...rest] = input.split(/\s+/);
  switch (command.toLowerCase()) {
    case "ajuda": case "help": return help();
    case "status": {
      const list = await accounts();
      console.table(list.map((item) => ({ conta: item.username, estado: item.status, atividade: item.activity, peixes: item.fishCount, erro: item.lastError || "" })));
      return;
    }
    case "conectar": return action(name, "connect");
    case "desconectar": return action(name, "disconnect");
    case "pescar": return action(name, "fish");
    case "pausar": return action(name, "pause");
    case "plot": return action(name, "plot");
    case "mercado": return action(name, "market");
    case "inventario": {
      for (const account of await targets(name)) {
        console.log(`\n${account.username} — ${account.fishCount} peixe(s)`);
        if (!account.inventory?.length) console.log("  inventário vazio");
        else console.table(account.inventory.map((item) => ({ item: item.name, nome: item.displayName, quantidade: item.count })));
      }
      return;
    }
    case "comando": {
      const message = rest.join(" ");
      if (!message) throw new Error("Informe o comando. Exemplo: comando todas /spawn");
      return action(name, "chat", { message });
    }
    case "dropar": {
      const [itemName, count] = rest;
      if (!itemName) throw new Error("Use: dropar CONTA ITEM QUANTIDADE");
      return action(name, "drop", { itemName, count: Number(count) || undefined });
    }
    case "dropar-tudo": return action(name, "dropall");
    default: throw new Error("Comando desconhecido. Digite ajuda.");
  }
}

console.clear();
console.log("NERDZONE — CONSOLE DOS BOTS");
console.log("Digite ajuda para ver os comandos.\n");
try {
  const list = await accounts();
  console.log(`${list.length} contas carregadas. Serviço online.`);
} catch {
  console.error("O painel/API não está disponível. Abra 'Abrir Painel.bat' primeiro.");
  process.exit(1);
}
help();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "nerdzone> " });
rl.prompt();
rl.on("line", async (line) => {
  if (["sair", "exit", "quit"].includes(line.trim().toLowerCase())) return rl.close();
  try { await run(line); } catch (error) { console.error(`ERRO: ${error.message}`); }
  rl.prompt();
});
rl.on("close", () => process.exit(0));
