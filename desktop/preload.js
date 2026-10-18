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
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  appInfo: () => ipcRenderer.invoke("app:info"),

  tips: {
    cached: () => ipcRenderer.invoke("tips:cached"),
    refresh: () => ipcRenderer.invoke("tips:refresh"),
    verifyForebet: () => ipcRenderer.invoke("tips:verify-forebet"),
    onProgress: (callback) => ipcRenderer.on("tips:progress", (_event, message) => callback(String(message))),
  },
  history: {
    list: (days) => ipcRenderer.invoke("history:list", days),
    setOutcome: (id, outcome) => ipcRenderer.invoke("history:set-outcome", { id, outcome }),
    evaluate: () => ipcRenderer.invoke("history:evaluate"),
  },
});
