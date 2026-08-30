import { spawn } from "node:child_process";
import { IpcMain } from "../main.js";
import { encodeUtf8, decodeUtf8 } from "../codec.js";

const PORT = 45900;
const ipc = new IpcMain();

ipc.handle("echo", (payload: Uint8Array) => {
  return Promise.resolve(encodeUtf8("echo:" + decodeUtf8(payload)));
});

ipc.handle("sum", (payload: Uint8Array) => {
  let total = 0;
  for (let i = 0; i < payload.length; i++) total = total + payload[i]!;
  return Promise.resolve(encodeUtf8("" + total));
});

ipc.handle("boom", (payload: Uint8Array) => {
  return Promise.reject(new Error("handler exploded"));
});

ipc.handle("run", (payload: Uint8Array) => {
  return new Promise<Uint8Array>((resolve) => {
    const argv = decodeUtf8(payload);
    const child = spawn("/usr/bin/uname", ["-s"], { stdio: ["inherit", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout!.on("data", (d: Buffer) => { out = out + decodeUtf8(toU8(d)); });
    child.stderr!.on("data", (d: Buffer) => { err = err + decodeUtf8(toU8(d)); });
    child.on("exit", (code: number | null) => {
      resolve(encodeUtf8("exit=" + (code ?? 0) + " out=" + out.trim()));
    });
  });
});

function toU8(d: Buffer): Uint8Array {
  const u = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) u[i] = d[i]!;
  return u;
}

ipc.on("log", (payload: Uint8Array) => {
  console.log("[main] renderer says: " + decodeUtf8(payload));
});

ipc.onConnect(() => {
  ipc.send("tick", encodeUtf8("from-main"));
});

ipc.listen(PORT, "127.0.0.1");
console.log("[main] listening");

const child = spawn(process.env.NT_RENDERER ?? "./renderer_t", [], {
  stdio: "inherit",
  env: { NT_IPC_PORT: "" + PORT },
});
child.on("exit", (code: number | null) => {
  console.log("[main] renderer exit " + (code ?? 0));
  process.exit(code ?? 0);
});
