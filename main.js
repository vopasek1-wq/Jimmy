// AI Dashboard – hlavní proces Electronu (Windows desktop aplikace).
"use strict";

const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const DESIGN_SIZE = { width: 1536, height: 1024 };
const isHttpUrl = (url) => /^https?:\/\//i.test(url);

let mainWindow = null;

function createWindow() {
  // Velikost podle návrhu, ale nikdy větší než pracovní plocha monitoru.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(DESIGN_SIZE.width, workAreaSize.width);
  const height = Math.min(DESIGN_SIZE.height, workAreaSize.height);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1024,
    minHeight: 680,
    frame: false, // vlastní titulní lišta z návrhu
    backgroundColor: "#080f17",
    title: "AI Dashboard",
    icon: path.join(__dirname, "build", "icon.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (width < DESIGN_SIZE.width || height < DESIGN_SIZE.height) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow.show());

  const sendMaximized = () => mainWindow.webContents.send("win:maximized", mainWindow.isMaximized());
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);
  mainWindow.webContents.on("did-finish-load", sendMaximized);

  // Odkazy a vyhledávání se otevírají ve výchozím prohlížeči, ne uvnitř aplikace.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

/* ---------- Ovládání okna ---------- */
const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);
ipcMain.on("win:minimize", (e) => senderWindow(e)?.minimize());
ipcMain.on("win:toggle-maximize", (e) => {
  const win = senderWindow(e);
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("win:close", (e) => senderWindow(e)?.close());

/* ---------- Systémové informace ---------- */
let lastCpu = os.cpus().map((c) => c.times);

function cpuUsage() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const prev = lastCpu[i] || t;
    const busy = (t.user - prev.user) + (t.nice - prev.nice) + (t.sys - prev.sys) + (t.irq - prev.irq);
    const free = t.idle - prev.idle;
    idle += free;
    total += busy + free;
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

function diskUsage() {
  const root = process.platform === "win32" ? "C:\\" : "/";
  try {
    const s = fs.statfsSync(root);
    return Math.round((1 - s.bavail / s.blocks) * 100);
  } catch {
    return null;
  }
}

function osName() {
  if (process.platform !== "win32") return os.type();
  // Windows 11 má stále verzi jádra 10.0, liší se číslem buildu (22000+).
  const build = Number(os.release().split(".")[2] || 0);
  return build >= 22000 ? "Windows 11" : "Windows 10";
}

ipcMain.handle("sys:stats", () => ({
  cpu: cpuUsage(),
  ram: Math.round((1 - os.freemem() / os.totalmem()) * 100),
  disk: diskUsage(),
}));

ipcMain.handle("sys:info", () => ({
  os: osName(),
  version: app.getVersion(),
}));

/* ---------- Rychlé akce ---------- */
ipcMain.handle("action:open-web", () => shell.openExternal("https://www.google.com/"));
ipcMain.handle("action:open-folder", () => shell.openPath(app.getPath("documents")));
ipcMain.handle("action:launch-app", async (e) => {
  const win = senderWindow(e);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Spustit aplikaci",
    properties: ["openFile"],
    filters: process.platform === "win32"
      ? [{ name: "Aplikace", extensions: ["exe", "lnk", "bat", "cmd"] }]
      : [{ name: "Všechny soubory", extensions: ["*"] }],
  });
  if (canceled || !filePaths[0]) return false;
  const error = await shell.openPath(filePaths[0]);
  return error === "";
});

/* ---------- Životní cyklus ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("cz.jimmy.aidashboard");
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
