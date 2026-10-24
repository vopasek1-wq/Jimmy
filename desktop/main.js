// Fotbalové tipy – hlavní proces Electronu (Windows desktop aplikace).
"use strict";

const { app, BrowserWindow, ipcMain, shell, screen, net, session, clipboard, safeStorage, Notification } = require("electron");
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
const { checkForUpdate } = require("./src/updates");
const { loadState, saveState, pickBounds } = require("./src/windowstate");

const DESIGN_SIZE = { width: 1440, height: 900 };
const isHttpUrl = (url) => /^https?:\/\//i.test(String(url));

let mainWindow = null;
let service = null;
const windowStateFile = () => path.join(app.getPath("userData"), "window.json");

function createWindow() {
  // Okno se vždy otevře maximalizované, a to na monitoru, kde bylo naposledy (jinak na hlavním); velikost podle návrhu
  // (nikdy větší než pracovní plocha) platí, až když ho uživatel zmenší.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const remembered = pickBounds(loadState(windowStateFile()), screen.getAllDisplays().map((d) => d.workArea));
  const width = remembered ? remembered.width : Math.min(DESIGN_SIZE.width, workAreaSize.width);
  const height = remembered ? remembered.height : Math.min(DESIGN_SIZE.height, workAreaSize.height);

  mainWindow = new BrowserWindow({
    ...(remembered ? { x: remembered.x, y: remembered.y } : {}),
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

  // Poloha okna se průběžně ukládá: při dalším spuštění se otevře na stejném monitoru.
  let saveTimer = null;
  const rememberWindow = () => {
    if (mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible()) return;
    const display = screen.getDisplayMatching(mainWindow.getBounds());
    saveState(windowStateFile(), { ...mainWindow.getNormalBounds(), display: display.workArea });
  };
  const rememberSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(rememberWindow, 500); };
  for (const ev of ["move", "resize", "maximize", "unmaximize"]) mainWindow.on(ev, rememberSoon);
  mainWindow.on("close", () => { clearTimeout(saveTimer); rememberWindow(); });

  const sendMaximized = () => mainWindow.webContents.send("win:maximized", mainWindow.isMaximized());
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);
  mainWindow.webContents.on("did-finish-load", sendMaximized);

  // Minimalizované nebo skryté okno: aplikace přestane obnovovat živé zápasy (po návratu se hned doplní).
  const sendVisible = () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send("win:visible", mainWindow.isVisible() && !mainWindow.isMinimized()); };
  for (const ev of ["minimize", "restore", "show", "hide"]) mainWindow.on(ev, sendVisible);

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
ipcMain.handle("app:info", () => ({
  version: app.getVersion(), dataDir: app.getPath("userData"),
  leagues: config.LEAGUES.filter((l) => l.enabled).map((l) => ({ key: l.key, short: l.short, nameCs: l.nameCs })),
  limits: { minProbability: config.MIN_PROBABILITY, minOdds: config.MIN_ODDS, highProbability: config.HIGH_PROBABILITY },
}));

/* ---------- Nová verze (GitHub vydání „tipy-latest“) ---------- */
let update = null; // poslední zjištěné novější sestavení { current, latest, url, published }
async function checkUpdate() {
  // vývojová verze (npm start) se nekontroluje, jen zabalená aplikace
  if (!app.isPackaged && !process.env.TIPSTER_UPDATE_TEST) return;
  const info = await checkForUpdate({ fetchFn: (url, init) => net.fetch(url, init), version: app.getVersion() });
  if (info.error || !info.available) return;
  const isNew = !update || update.latest !== info.latest;
  update = info;
  if (isNew && mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("update:available", info);
}
ipcMain.handle("update:get", () => update);


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
// Ruční kontrola (tlačítko „Aktualizace“): na rozdíl od automatické běží i ve vývojové verzi a chybu hlásí.
ipcMain.handle("update:check", safe(async () => {
  const info = await checkForUpdate({ fetchFn: (url, init) => net.fetch(url, init), version: app.getVersion() });
  if (info.notFound) return { notFound: true, current: info.current, url: config.RELEASE_PAGE }; // soukromý repozitář
  if (info.error) throw new Error(info.error);
  if (info.available) update = info;
  return info;
}));

/* ---------- Diagnostika pro vývojáře (Ctrl + Shift + D) ---------- */
ipcMain.handle("diag:copy", safe(() => {
  const text = service.diagnosticsText({ version: app.getVersion(), electron: process.versions.electron, platform: `${process.platform} ${process.getSystemVersion()}` });
  clipboard.writeText(text);
  return { chars: text.length };
}));
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
  const result = await createTickets({
    candidates, calibration, ask, progress,
    collect: (list, report) => service.collectTicketStats(list, report),
    hint: ` Podrobnosti: ${service.ticketDiagnosticsFile()}`,
    log: (text) => service.writeTicketLog(text),
  });
  try { service.saveTickets(result.tickets); } catch (err) { console.error(err); } // uložení nesmí shodit výsledek
  return result;
}));
ipcMain.handle("tickets:history", safe(() => service.ticketHistory()));

// Upozornění 15 minut před začátkem zápasu z čekajícího tiketu (jen systémové oznámení, jednou na zápas).
const notifiedKickoffs = new Set();
function notifyKickoffs() {
  if (!service || !Notification.isSupported()) return;
  try {
    for (const k of service.dueKickoffs(notifiedKickoffs)) new Notification({ title: "Zápas z tvého tiketu brzy začíná", body: `${k.matchName} – za ${k.minutes} min (${k.ticketName})`, silent: false }).show();
  } catch (err) { console.error(err); }
}
ipcMain.handle("tips:live", safe(() => service.refreshLive()));
ipcMain.handle("tips:stats", safe((_e, id, forebetUrl) => service.matchDetail(id, forebetUrl)));
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
    setTimeout(checkUpdate, 6000).unref();
    setInterval(checkUpdate, 6 * 3600e3).unref();
    setInterval(notifyKickoffs, 60e3).unref();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    service?.close();
    if (process.platform !== "darwin") app.quit();
  });
}
