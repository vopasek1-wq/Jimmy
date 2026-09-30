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
});
