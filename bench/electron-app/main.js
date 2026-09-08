const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const START_MS = Date.now();
const BENCH_START_MS = +(process.env.NT_BENCH_START_MS || 0);
const start = BENCH_START_MS > 0 && BENCH_START_MS <= START_MS ? BENCH_START_MS : START_MS;
const phase = (name) => console.log(`NT_BENCH_PHASE=${name}:${Date.now() - start}`);

phase("main-entry");
ipcMain.on("nt-bench-renderer-entry", (_event, timestamp) => {
  if (Number.isInteger(timestamp) && timestamp >= start && timestamp <= Date.now()) {
    console.log(`NT_BENCH_PHASE=renderer-entry:${timestamp - start}`);
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 360,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  phase("window-created");
  phase("browser-created");
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.once("did-finish-load", async () => {
    phase("host-ready");
    phase("ui-applied");
    if (process.env.NT_BENCH_QUIT !== "1" && process.env.NT_BENCH_RUNTIME !== "1") return;
    const frames = await win.webContents.executeJavaScript(
      "new Promise(function(resolve){requestAnimationFrame(function(){var one=Date.now();requestAnimationFrame(function(){var fcp=0;var paints=performance.getEntriesByType('paint');for(var i=0;i<paints.length;i++){if(paints[i].name==='first-contentful-paint')fcp=Math.round(performance.timeOrigin+paints[i].startTime)}resolve([one,Date.now(),fcp])})})})",
    );
    console.log(`NT_BENCH_PHASE=frame-one:${frames[0] - start}`);
    if (frames[2] > 0) console.log(`NT_BENCH_PHASE=contentful-paint:${frames[2] - start}`);
    console.log(`NT_READY_MS=${frames[1] - start}`);
    if (process.env.NT_BENCH_QUIT === "1") app.quit();
    else console.log("NT_RUNTIME_READY=1");
  });
}

app.whenReady().then(() => {
  phase("app-ready");
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
