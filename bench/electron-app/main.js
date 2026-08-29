const { app, BrowserWindow } = require("electron");
const path = require("path");

const START_MS = Date.now();

function createWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 360,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.once("did-finish-load", () => {
    if (process.env.NT_BENCH_QUIT === "1") {
      console.log(`NT_READY_MS=${Date.now() - START_MS}`);
      app.quit();
    }
  });
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
