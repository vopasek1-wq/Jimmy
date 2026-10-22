// Fotbalové tipy – hlavní proces Electronu (Windows desktop aplikace).
"use strict";

const { app, BrowserWindow, ipcMain, shell, screen, net, session, clipboard, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// ASCII název složky s daty (%APPDATA%\FotbalTipy); pro zkoušení jde přesměrovat proměnnou TIPSTER_DATA_DIR.
app.setName("FotbalTipy");
app.commandLine.appendSwitch("lang", "cs"); // české názvy v kalendáři a formát data
if (process.env.TIPSTER_DATA_DIR) app.setPath("userData", process.env.TIPSTER_DATA_DIR);

const config = require("./src/config");
const { HttpClient } = require("./src/http");
const { WindowBrowser, chromeUserAgent } = require("./src/browser");
const { TipService } = require("./src/service");
const { askGemini, generate } = require("./src/analysis");
const { createTickets } = require("./src/tickets");

const DESIGN_SIZE = { width: 1440, height: 900 };
const isHttpUrl = (url) => /^https?:\/\//i.test(String(url));

let mainWindow = null;
let service = null;

function createWindow() {
  // Okno se vždy otevře maximalizované; velikost podle návrhu (nikdy větší než pracovní plocha) platí, až když ho uživatel zmenší.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(DESIGN_SIZE.width, workAreaSize.width);
  const height = Math.min(DESIGN_SIZE.height, workAreaSize.height);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1024,
    minHeight: 640,
    frame: false, // vlastní titulní lišta (stejně jako J.I.M.M.Y.)
    backgroundColor: "#080f17",
    title: "Fotbalové tipy",
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

  mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow.show());

  const sendMaximized = () => mainWindow.webContents.send("win:maximized", mainWindow.isMaximized());
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);
  mainWindow.webContents.on("did-finish-load", sendMaximized);

  // Odkazy se otevírají ve výchozím prohlížeči, ne uvnitř aplikace.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
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

ipcMain.on("shell:open-external", (_e, url) => { if (isHttpUrl(url)) shell.openExternal(String(url)); });
ipcMain.handle("clipboard:write", (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle("app:info", () => ({
  version: app.getVersion(), dataDir: app.getPath("userData"), tipsportUrl: config.TIPSPORT_URL,
  leagues: config.LEAGUES.filter((l) => l.enabled).map((l) => ({ key: l.key, short: l.short, nameCs: l.nameCs })),
  limits: { minProbability: config.MIN_PROBABILITY, minOdds: config.MIN_ODDS, highProbability: config.HIGH_PROBABILITY },
}));

/* ---------- Tipy ---------- */
const progressTo = (event) => (message) => {
  if (!event.sender.isDestroyed()) event.sender.send("tips:progress", message);
};
// Chyba v hlavním procesu se do okna předá jako text, ne jako výjimka IPC.
const safe = (fn) => async (...args) => {
  try {
    return { ok: true, data: await fn(...args) };
  } catch (err) {
    console.error(err);
    return { ok: false, error: err.message || String(err) };
  }
};

ipcMain.handle("tips:cached", safe(() => service.loadCached()));
ipcMain.handle("live:list", safe(() => service.liveMatches()));
ipcMain.handle("live:detail", safe((_e, id) => service.liveDetail(id)));
/* ---------- AI analýza: klíč se ukládá šifrovaně (Windows DPAPI přes safeStorage) ---------- */
const keyFile = () => path.join(app.getPath("userData"), "ai-key.bin");
const readKey = () => {
  try { return safeStorage.decryptString(fs.readFileSync(keyFile())); } catch { return ""; }
};
ipcMain.handle("analysis:get", safe(() => service.analysis()));
ipcMain.handle("analysis:has-key", () => Boolean(readKey()));
ipcMain.handle("analysis:set-key", safe((_e, key) => {
  const k = String(key || "").trim();
  if (!k) { fs.rmSync(keyFile(), { force: true }); return false; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Na tomto počítači nejde klíč bezpečně uložit.");
  fs.writeFileSync(keyFile(), safeStorage.encryptString(k));
  return true;
}));
ipcMain.handle("analysis:run", safe(async () => {
  const apiKey = readKey();
  if (!apiKey) throw new Error("Nejdřív zadej Gemini API klíč.");
  return askGemini({ fetchFn: (url, init) => net.fetch(url, init), apiKey, prompt: service.aiPrompt() });
}));
ipcMain.handle("tickets:create", safe(async (event, req) => {
  const apiKey = readKey();
  if (!apiKey) throw new Error("Nejdřív zadej Gemini API klíč.");
  const day = req && req.day === "tomorrow" ? "tomorrow" : "today";
  const { candidates, calibration } = service.ticketInput({ day });
  const ask = (options) => generate({ fetchFn: (url, init) => net.fetch(url, init), apiKey, ...options });
  const progress = (message) => { if (!event.sender.isDestroyed()) event.sender.send("tickets:progress", message); };
  return createTickets({ candidates, ask, calibration, progress });
}));
ipcMain.handle("tips:live", safe(() => service.refreshLive()));
ipcMain.handle("tips:refresh", safe((event) => service.refresh(progressTo(event))));
ipcMain.handle("tips:verify-forebet", safe((event) => service.refresh(progressTo(event), { interactiveForebet: true })));
ipcMain.handle("history:list", safe((_e, days) => service.history(days ?? null)));
ipcMain.handle("history:set-outcome", safe((_e, { id, outcome }) => service.setOutcome(id, outcome)));
ipcMain.handle("history:evaluate", safe((event) => service.evaluate(progressTo(event))));

/* ---------- Životní cyklus ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("cz.jimmy.fotbalovetipy");

    // Stahování přes síťový stack Chromia (systémová proxy a certifikáty Windows).
    const userAgent = chromeUserAgent(app.userAgentFallback);
    const http = new HttpClient({ fetchFn: (url, init) => net.fetch(url, init), userAgent });
    const browser = new WindowBrowser({ BrowserWindow, session, app });
    await browser.setScores24Cookies(config.SCORES24_BASE, config.SCORES24_COOKIES).catch(() => {});
    service = new TipService({ dbFile: path.join(app.getPath("userData"), "tipy.sqlite3"), http, browser });

    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    service?.close();
    if (process.platform !== "darwin") app.quit();
  });
}
