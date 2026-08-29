// Minimal Electron main process — functionally equivalent to nativetron's
// Phase 0 demo: open a single BrowserWindow that shows an <h1>Hello</h1> and a
// button that increments a counter held in the renderer.
//
// This is the Electron baseline for the nativetron benchmark. Unlike
// nativetron (where the click handler runs in AOT-native code over a bridge),
// here the counter logic runs as page JavaScript inside Chromium/V8 — the
// standard Electron model.
const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 360,
    show: true,
    webPreferences: {
      // Counter runs as plain page JS; no preload / node integration needed.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
