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
  openExternal: (url) => ipcRenderer.send("shell:open-external", url),
  appInfo: () => ipcRenderer.invoke("app:info"),

  tips: {
    cached: () => ipcRenderer.invoke("tips:cached"),
    live: () => ipcRenderer.invoke("tips:live"),
    refresh: () => ipcRenderer.invoke("tips:refresh"),
    verifyForebet: () => ipcRenderer.invoke("tips:verify-forebet"),
    onProgress: (callback) => ipcRenderer.on("tips:progress", (_event, message) => callback(String(message))),
  },
  diagnostics: { copy: () => ipcRenderer.invoke("diag:copy") },
  update: {
    get: () => ipcRenderer.invoke("update:get"),
    check: () => ipcRenderer.invoke("update:check"),
    onAvailable: (callback) => ipcRenderer.on("update:available", (_event, info) => callback(info)),
  },
  tickets: {
    create: (req) => ipcRenderer.invoke("tickets:create", req),
    history: () => ipcRenderer.invoke("tickets:history"),
    onProgress: (callback) => ipcRenderer.on("tickets:progress", (_event, message) => callback(String(message))),
  },
  analysis: {
    get: () => ipcRenderer.invoke("analysis:get"),
    hasKey: () => ipcRenderer.invoke("analysis:has-key"),
    setKey: (key) => ipcRenderer.invoke("analysis:set-key", key),
    run: () => ipcRenderer.invoke("analysis:run"),
  },
  live: {
    list: () => ipcRenderer.invoke("live:list"),
    detail: (id) => ipcRenderer.invoke("live:detail", id),
  },
  history: {
    list: (days) => ipcRenderer.invoke("history:list", days),
    setOutcome: (id, outcome) => ipcRenderer.invoke("history:set-outcome", { id, outcome }),
    evaluate: () => ipcRenderer.invoke("history:evaluate"),
    exportCsv: () => ipcRenderer.invoke("history:export"),
  },
});
