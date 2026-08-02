const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

app.setName("Nerdzone Bot Manager");

let mainWindow = null;

function hasProject(root) {
  return fs.existsSync(path.join(root, "bot-service", ".env")) &&
    fs.existsSync(path.join(root, "bot-service", "config", "accounts.json"));
}

function projectRoot() {
  const portableFolder = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableFolder && hasProject(portableFolder)) return portableFolder;
  const executableFolder = path.dirname(process.execPath);
  if (hasProject(executableFolder)) return executableFolder;
  const developmentRoot = path.resolve(__dirname, "..");
  if (hasProject(developmentRoot)) return developmentRoot;
  return path.join(process.resourcesPath, "app-data");
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

function runNode(script, cwd, args = [], extraEnv = {}) {
  const child = spawn(process.execPath, [...args, script], {
    cwd,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.unref();
  return child;
}

async function waitForPanel() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await portOpen(3000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function startServices(root) {
  const packagedCode = app.isPackaged ? path.join(process.resourcesPath, "app-data") : root;
  const dataRoot = hasProject(root) ? root : app.getPath("userData");
  const envFile = path.join(dataRoot, "bot-service", ".env");
  const configFolder = path.join(dataRoot, "bot-service", "config");
  const accounts = path.join(configFolder, "accounts.json");
  if (!fs.existsSync(envFile) || !fs.existsSync(accounts)) {
    throw new Error("A configuração das contas não foi encontrada ao lado do aplicativo.");
  }
  if (!(await portOpen(3100))) {
    runNode(path.join(packagedCode, "bot-service", "src", "server.mjs"), path.join(packagedCode, "bot-service"), [`--env-file=${envFile}`], { BOT_CONFIG_DIR: configFolder });
  }
  if (!(await portOpen(3000))) {
    runNode(path.join(packagedCode, "scripts", "panel-server.mjs"), packagedCode, [], { BOT_ENV_PATH: envFile });
  }
  if (!(await waitForPanel())) throw new Error("O painel local não respondeu na porta 3000.");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Nerdzone Bot Manager",
    icon: path.join(projectRoot(), "assets", "minecontrol-icon.png"),
    width: 1500,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#080b12",
    show: true,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith("http://127.0.0.1:3000") && !url.startsWith("http://localhost:3000")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("http://127.0.0.1:3000") && !url.startsWith("http://localhost:3000")) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.maximize();
  mainWindow.loadURL("http://127.0.0.1:3000");
}

app.whenReady().then(async () => {
  try {
    await startServices(projectRoot());
    createWindow();
  } catch (error) {
    dialog.showErrorBox("Nerdzone Bot Manager", error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
