// Chytrá schránka: historie kopírovaného textu, rychlé vkládání a AI úpravy textu (Gemini API).
"use strict";

const { app, clipboard, ipcMain, net, safeStorage, globalShortcut } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const MAX_ITEMS = 200;          // nepřipnuté položky navíc se mažou od nejstarších
const MAX_LENGTH = 20000;       // delší texty se neukládají
const POLL_MS = 800;
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

const file = (name) => path.join(app.getPath("userData"), name);

let history = [];
let paused = false;
let lastText = "";
let saveTimer = null;
let getWindow = () => null;

/* ---------- Uložení historie ---------- */
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file("clipboard-history.json"), "utf8"));
    history = Array.isArray(data.history) ? data.history : [];
    paused = Boolean(data.paused);
  } catch {
    history = [];
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(file("clipboard-history.json"), JSON.stringify({ history, paused }), () => {});
  }, 300);
}

function broadcast() {
  getWindow()?.webContents.send("clip:update", { history, paused });
  save();
}

function trim() {
  let unpinned = 0;
  history = history.filter((item) => item.pinned || ++unpinned <= MAX_ITEMS);
}

function add(text) {
  const existing = history.find((item) => item.text === text);
  history = history.filter((item) => item !== existing);
  history.unshift({
    id: existing?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text,
    time: Date.now(),
    pinned: existing?.pinned || false,
  });
  trim();
  broadcast();
}

/* ---------- Sledování schránky ---------- */
// Novější Electron vrací z clipboard.readText() Promise – Promise.resolve zvládne obě varianty.
const readClipboard = async () => {
  try {
    const text = await Promise.resolve(clipboard.readText());
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
};

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const text = await readClipboard();
    if (text === lastText) return;
    lastText = text;
    if (paused || !text.trim() || text.length > MAX_LENGTH) return;
    add(text);
  } finally {
    polling = false;
  }
}

const find = (id) => history.find((item) => item.id === id);

function copy(text) {
  Promise.resolve(clipboard.writeText(text)).catch(() => {});
  lastText = text; // vlastní zápis nezakládá novou položku, jen ji posune nahoru
  const item = history.find((i) => i.text === text);
  if (item && !paused) add(text);
}

// Vloží text do okna, které bylo aktivní před aplikací: schová okno a pošle Ctrl+V.
function pasteToPreviousApp(text) {
  copy(text);
  const win = getWindow();
  if (process.platform !== "win32") return false;
  win?.minimize();
  execFile("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 250; [System.Windows.Forms.SendKeys]::SendWait('^v')",
  ], { windowsHide: true }, () => {});
  return true;
}

/* ---------- Gemini API klíč (šifrovaně přes safeStorage) ---------- */
function readKey() {
  try {
    const raw = fs.readFileSync(file("gemini-key.bin"));
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
  } catch {
    return "";
  }
}

function writeKey(key) {
  const target = file("gemini-key.bin");
  if (!key) {
    fs.rmSync(target, { force: true });
    return;
  }
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, "utf8");
  fs.writeFileSync(target, data);
}

async function transform({ text, instruction }) {
  const key = readKey();
  if (!key) throw new Error("NO_KEY");
  const prompt = `${instruction}\n\nVrať pouze upravený text, bez komentářů, úvodu a uvozovek.\n\nText:\n${text}`;
  const res = await net.fetch(GEMINI_API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  const out = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
  if (!out) throw new Error("Gemini nevrátil žádný text.");
  return out;
}

/* ---------- Napojení ---------- */
function setupClipboard(windowGetter) {
  getWindow = windowGetter;
  load();
  // Co už ve schránce je, se při startu nepřidává.
  readClipboard().then((text) => {
    lastText = text;
    setInterval(poll, POLL_MS);
  });

  ipcMain.handle("clip:list", () => ({ history, paused }));
  ipcMain.handle("clip:copy", (_e, id) => { const item = find(id); if (item) copy(item.text); });
  ipcMain.handle("clip:copy-text", (_e, text) => copy(String(text)));
  ipcMain.handle("clip:paste", (_e, id) => { const item = find(id); return item ? pasteToPreviousApp(item.text) : false; });
  ipcMain.handle("clip:paste-text", (_e, text) => pasteToPreviousApp(String(text)));
  ipcMain.handle("clip:pin", (_e, id) => { const item = find(id); if (item) { item.pinned = !item.pinned; broadcast(); } });
  ipcMain.handle("clip:delete", (_e, id) => { history = history.filter((i) => i.id !== id); broadcast(); });
  ipcMain.handle("clip:clear", () => { history = history.filter((i) => i.pinned); broadcast(); });
  ipcMain.handle("clip:pause", async (_e, value) => { paused = Boolean(value); lastText = await readClipboard(); broadcast(); });

  ipcMain.handle("ai:has-key", () => Boolean(readKey()));
  ipcMain.handle("ai:set-key", (_e, key) => { writeKey(String(key || "").trim()); return Boolean(readKey()); });
  ipcMain.handle("ai:transform", async (_e, payload) => {
    try {
      return { ok: true, text: await transform(payload) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Rychlé otevření schránky odkudkoliv: Alt+Shift+V
  globalShortcut.register("Alt+Shift+V", () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("view:show", "clipboard");
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
}

module.exports = { setupClipboard };
