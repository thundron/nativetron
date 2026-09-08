const { ipcRenderer } = require("electron");
ipcRenderer.send("nt-bench-renderer-entry", Date.now());
