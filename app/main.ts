import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { IpcMain } from "../ipc/main.js";
import { encodeUtf8, decodeUtf8 } from "../ipc/codec.js";

declare function ntOnOpenFile(cb: (path: string) => void): void;
declare function ntOnOpenUrl(cb: (url: string) => void): void;
declare function ntAssociationsStart(): number;
declare function ntAssociationsSelftest(file: string, url: string): number;
declare function ntPump(): number;

const ipc = new IpcMain();
const pendingOpenFiles: string[] = [];
const pendingOpenUrls: string[] = [];
ntOnOpenFile((path: string) => {
  if (ipc.send("app:open-file", encodeUtf8(path))) return;
  if (pendingOpenFiles.length < 256) pendingOpenFiles.push(path);
  else console.log("[association] dropped open-file event: pending queue full");
});
ntOnOpenUrl((url: string) => {
  if (ipc.send("app:open-url", encodeUtf8(url))) return;
  if (pendingOpenUrls.length < 256) pendingOpenUrls.push(url);
  else console.log("[association] dropped open-url event: pending queue full");
});
const associationsStarted = ntAssociationsStart() === 1;
if (!associationsStarted) console.log("[association] Apple Event registration failed");
setInterval(() => { ntPump(); }, 8);

ipc.onConnect(() => {
  for (let i = 0; i < pendingOpenFiles.length; i++)
    ipc.send("app:open-file", encodeUtf8(pendingOpenFiles[i]!));
  for (let i = 0; i < pendingOpenUrls.length; i++)
    ipc.send("app:open-url", encodeUtf8(pendingOpenUrls[i]!));
  pendingOpenFiles.splice(0, pendingOpenFiles.length);
  pendingOpenUrls.splice(0, pendingOpenUrls.length);
});

ipc.on("app:test-associations", (_payload: Uint8Array) => {
  if (process.env.NT_SELFTEST === "associations" && associationsStarted) {
    ntAssociationsSelftest("/tmp/nativetron association.nativetron", "nativetron://open?value=caf%C3%A9");
  }
});

ipc.handle("os:homedir", (payload: Uint8Array) => {
  return Promise.resolve(encodeUtf8(homedir()));
});

ipc.handle("crypto:uuid", (payload: Uint8Array) => {
  return Promise.resolve(encodeUtf8(randomUUID()));
});

ipc.handle("crypto:sha256", (payload: Uint8Array) => {
  return Promise.resolve(encodeUtf8(createHash("sha256").update(decodeUtf8(payload)).digest("hex")));
});

ipc.handle("fs:list", async (payload: Uint8Array) => {
  const dir = decodeUtf8(payload);
  const names = await readdir(dir);
  const out: string[] = [];
  for (let i = 0; i < names.length && i < 200; i++) out.push(names[i]!);
  return encodeUtf8(out.join("\n"));
});

ipc.handle("fs:read", async (payload: Uint8Array) => {
  const text = await readFile(decodeUtf8(payload), "utf8");
  return encodeUtf8(text);
});

ipc.handle("fs:stat", async (payload: Uint8Array) => {
  const s = await stat(decodeUtf8(payload));
  return encodeUtf8(s.isDirectory() ? "dir" : "file " + s.size);
});

ipc.handle("proc:uname", (payload: Uint8Array) => {
  const flag = decodeUtf8(payload);
  if (flag !== "-a" && flag !== "-s") throw new Error("uname argument is not allowed");
  return new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn("/usr/bin/uname", [flag], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    let output = "";
    let errorOutput = "";
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("uname timed out"));
    }, 5000);
    child.stdout!.on("data", (data: Buffer) => {
      if (settled) return;
      outputBytes += data.length;
      if (outputBytes > 4096) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error("uname output limit exceeded"));
        return;
      }
      output += decodeUtf8(data);
    });
    child.stderr!.on("data", (data: Buffer) => {
      if (settled) return;
      outputBytes += data.length;
      if (outputBytes > 4096) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error("uname output limit exceeded"));
        return;
      }
      errorOutput += decodeUtf8(data);
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(encodeUtf8(output));
      else reject(new Error("uname failed: " + (code === null ? "signal" : "" + code) + " " + errorOutput));
    });
  });
});

ipc.on("renderer:log", (payload: Uint8Array) => {
  console.log("[renderer] " + decodeUtf8(payload));
});

ipc.listen(0, "127.0.0.1");
ipc.onListening((port: number) => {
  const rendererPath = process.env.NT_RENDERER_PATH ?? join(process.cwd(), "build", "renderer");
  const renderer = spawn(rendererPath, [], {
    stdio: "inherit",
    env: {
      NT_IPC_PORT: "" + port,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NT_SELFTEST: process.env.NT_SELFTEST ?? "",
      NT_BENCH_QUIT: process.env.NT_BENCH_QUIT ?? "",
      NT_BENCH_START_MS: process.env.NT_BENCH_START_MS ?? "",
      NT_BLOCKING_RUN: process.env.NT_BLOCKING_RUN ?? "",
    },
  });
  renderer.on("exit", (code: number | null) => {
    process.exit(code ?? 0);
  });
});
