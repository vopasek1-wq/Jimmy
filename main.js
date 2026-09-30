// AI Dashboard – hlavní proces Electronu (Windows desktop aplikace).
"use strict";

const { app, BrowserWindow, ipcMain, shell, screen, net, session } = require("electron");
const path = require("node:path");
const { fetchNews } = require("./news");
const { fetchWeather } = require("./weather");

const DESIGN_SIZE = { width: 1536, height: 1024 };
const isHttpUrl = (url) => /^https?:\/\//i.test(url);

/* Gemini se vkládá přes <webview> (gemini.google.com zakazuje vložení do iframe). */
const GEMINI_URL = "https://gemini.google.com/app";
const GEMINI_PARTITION = "persist:gemini"; // vlastní trvalé úložiště → přihlášení vydrží
const isGoogleUrl = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && /(^|\.)(google\.com|google\.cz|gstatic\.com|googleusercontent\.com)$/.test(hostname);
  } catch {
    return false;
  }
};

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
      webviewTag: true,
    },
  });

  // Povolit jen webview s Gemini a vždy s bezpečným nastavením (bez preloadu a Node).
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!params.src.startsWith(GEMINI_URL) || params.partition !== GEMINI_PARTITION) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
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

/* ---------- Novinky (RSS) ---------- */
// Stahuje hlavní proces přes síťový stack Chromia (systémové proxy a certifikáty Windows).
ipcMain.handle("news:fetch", () => fetchNews((url, init) => net.fetch(url, init)));

/* ---------- Počasí (Open-Meteo) ---------- */
ipcMain.handle("weather:fetch", () => fetchWeather((url, init) => net.fetch(url, init)));

/* ---------- Gemini ve webview ---------- */
// Google blokuje přihlášení v prohlížečích, které se hlásí jako Electron → běžný Chrome UA
// (z identifikace se odstraní vše kromě Mozilla/AppleWebKit/Chrome/Safari).
const chromeUserAgent = () => app.userAgentFallback
  .replace(/\s(?!(?:AppleWebKit|Chrome|Safari)\/)[\w.-]+\/\S+/g, "");

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setUserAgent(chromeUserAgent());
  // Stránky Googlu (Gemini, přihlášení) zůstávají v panelu, vše ostatní jde do prohlížeče.
  contents.on("will-navigate", (event, url) => {
    if (isGoogleUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
});

ipcMain.on("gemini:open-external", () => shell.openExternal(GEMINI_URL));

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
    session.fromPartition(GEMINI_PARTITION).setUserAgent(chromeUserAgent());
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
