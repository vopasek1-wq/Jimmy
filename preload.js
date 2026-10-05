// Bezpečný most mezi stránkou a hlavním procesem (contextIsolation + sandbox).
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
  onMaximizedChange: (callback) => {
    ipcRenderer.on("win:maximized", (_event, maximized) => callback(Boolean(maximized)));
  },
  fetchNews: () => ipcRenderer.invoke("news:fetch"),
  fetchWeather: () => ipcRenderer.invoke("weather:fetch"),
  weatherSummary: (brief) => ipcRenderer.invoke("weather:ai-summary", brief),
  openGeminiExternal: () => ipcRenderer.send("gemini:open-external"),
  openChatGPTExternal: () => ipcRenderer.send("chatgpt:open-external"),
  onShowView: (callback) => ipcRenderer.on("view:show", (_event, view) => callback(view)),

  // Chytrá schránka
  clipboard: {
    list: () => ipcRenderer.invoke("clip:list"),
    onUpdate: (callback) => ipcRenderer.on("clip:update", (_event, data) => callback(data)),
    copy: (id) => ipcRenderer.invoke("clip:copy", id),
    copyText: (text) => ipcRenderer.invoke("clip:copy-text", text),
    paste: (id) => ipcRenderer.invoke("clip:paste", id),
    pasteText: (text) => ipcRenderer.invoke("clip:paste-text", text),
    pin: (id) => ipcRenderer.invoke("clip:pin", id),
    remove: (id) => ipcRenderer.invoke("clip:delete", id),
    clear: () => ipcRenderer.invoke("clip:clear"),
    pause: (value) => ipcRenderer.invoke("clip:pause", value),
  },
  ai: {
    hasKey: () => ipcRenderer.invoke("ai:has-key"),
    setKey: (key) => ipcRenderer.invoke("ai:set-key", key),
    transform: (text, instruction) => ipcRenderer.invoke("ai:transform", { text, instruction }),
  },
});
