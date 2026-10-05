// J.I.M.M.Y. – hlavní proces Electronu (Windows desktop aplikace).
"use strict";

const { app, BrowserWindow, ipcMain, shell, screen, net, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Data (úkoly, historie schránky, přihlášení do Gemini) zůstávají ve složce z doby,
// kdy se aplikace jmenovala „AI Dashboard“ – po přejmenování se nic neztratí.
const legacyUserData = path.join(app.getPath("appData"), "AI Dashboard");
if (fs.existsSync(legacyUserData)) app.setPath("userData", legacyUserData);
const { fetchNews } = require("./news");
const { fetchWeather } = require("./weather");
const { setupClipboard, askGemini, hasGeminiKey } = require("./clipboard");

const DESIGN_SIZE = { width: 1536, height: 1024 };
const isHttpUrl = (url) => /^https?:\/\//i.test(url);

/* Gemini a ChatGPT se vkládají přes <webview> (oba weby zakazují vložení do iframe).
   Každý má vlastní trvalé úložiště (přihlášení vydrží) a seznam domén, které smí zůstat v panelu. */
const httpsHostMatches = (url, pattern) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && pattern.test(hostname);
  } catch {
    return false;
  }
};
const WEBVIEWS = {
  gemini: {
    url: "https://gemini.google.com/app",
    partition: "persist:gemini",
    allowed: /(^|\.)(google\.com|google\.cz|gstatic\.com|googleusercontent\.com)$/,
  },
  chatgpt: {
    url: "https://chatgpt.com/",
    partition: "persist:chatgpt",
    // OpenAI + přihlášení přes Google, Microsoft a Apple
    allowed: /(^|\.)(chatgpt\.com|openai\.com|oaistatic\.com|oaiusercontent\.com|google\.com|gstatic\.com|live\.com|microsoftonline\.com|microsoft\.com|apple\.com)$/,
  },
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
    title: "J.I.M.M.Y.",
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

  // Povolit jen webview s Gemini / ChatGPT a vždy s bezpečným nastavením (bez preloadu a Node).
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const known = Object.values(WEBVIEWS).some((w) => params.src.startsWith(w.url) && params.partition === w.partition);
    if (!known) {
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

// AI doporučení k počasí (Gemini API, stejný klíč jako v Chytré schránce).
ipcMain.handle("weather:ai-summary", async (_e, brief) => {
  if (!hasGeminiKey()) return { ok: false, error: "NO_KEY" };
  try {
    const text = await askGemini(
      "Jsi stručný osobní asistent. Na základě hodinové předpovědi napiš 1–2 krátké věty česky, " +
      "v tykání, s praktickým doporučením na dnešek (deštník, oblečení, kdy je nejlepší čas ven). " +
      "Bez úvodu, bez emoji navíc, max. 220 znaků.\n\n" + String(brief).slice(0, 4000),
    );
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ---------- Gemini a ChatGPT ve webview ---------- */
// Google blokuje přihlášení v prohlížečích, které se hlásí jako Electron → běžný Chrome UA
// (z identifikace se odstraní vše kromě Mozilla/AppleWebKit/Chrome/Safari).
const chromeUserAgent = () => app.userAgentFallback
  .replace(/\s(?!(?:AppleWebKit|Chrome|Safari)\/)[\w.-]+\/\S+/g, "");

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setUserAgent(chromeUserAgent());
  const site = Object.values(WEBVIEWS).find((w) => contents.session === session.fromPartition(w.partition));
  // Stránky služby (a přihlášení) zůstávají v panelu, vše ostatní jde do prohlížeče.
  contents.on("will-navigate", (event, url) => {
    if (site && httpsHostMatches(url, site.allowed)) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
});

ipcMain.on("gemini:open-external", () => shell.openExternal(WEBVIEWS.gemini.url));
ipcMain.on("chatgpt:open-external", () => shell.openExternal(WEBVIEWS.chatgpt.url));

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
    Object.values(WEBVIEWS).forEach((w) => session.fromPartition(w.partition).setUserAgent(chromeUserAgent()));
    createWindow();
    setupClipboard(() => mainWindow);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
