import { spawn } from "node:child_process";
import { IpcMain } from "../../ipc/main.js";

const started = +(process.env.NT_BENCH_START_MS ?? "0");

function phase(name: string): void {
  if (started > 0) console.log("NT_BENCH_PHASE=" + name + ":" + (Date.now() - started));
}

phase("main-entry");
const ipc = new IpcMain();
ipc.listen(0, "127.0.0.1");
ipc.onListening((port: number) => {
  phase("ipc-listening");
  const renderer = spawn(process.env.NT_RENDERER_PATH ?? "bench/desktop-app/build/renderer", [], {
    stdio: "inherit",
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      NT_BENCH_QUIT: process.env.NT_BENCH_QUIT ?? "",
      NT_BENCH_RUNTIME: process.env.NT_BENCH_RUNTIME ?? "",
      NT_BENCH_START_MS: process.env.NT_BENCH_START_MS ?? "",
      NT_BLOCKING_RUN: process.env.NT_BLOCKING_RUN ?? "",
      NT_IPC_PORT: "" + port,
    },
  });
  renderer.on("exit", (code: number | null) => { process.exit(code ?? 0); });
});
