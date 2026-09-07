const { app, BrowserWindow } = require("electron");
const path = require("path");

const START_MS = Date.now();
const BENCH_START_MS = +(process.env.NT_BENCH_START_MS || 0);

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
      const start = BENCH_START_MS > 0 && BENCH_START_MS <= Date.now() ? BENCH_START_MS : START_MS;
      console.log(`NT_READY_MS=${Date.now() - start}`);
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
