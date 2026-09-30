// AI Dashboard – hlavní proces Electronu (Windows desktop aplikace).
"use strict";

const { app, BrowserWindow, ipcMain, shell, screen, net } = require("electron");
const path = require("node:path");
const { fetchNews } = require("./news");

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

/* ---------- Novinky (RSS) ---------- */
// Stahuje hlavní proces přes síťový stack Chromia (systémové proxy a certifikáty Windows).
ipcMain.handle("news:fetch", () => fetchNews((url, init) => net.fetch(url, init)));

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
