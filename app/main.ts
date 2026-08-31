import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { IpcMain } from "../ipc/main.js";
import { encodeUtf8, decodeUtf8 } from "../ipc/codec.js";
import { reviewRelease, type ReleaseReviewRequest } from "../pyrus/release-review.js";

const ipc = new IpcMain();

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

ipc.handle("pyrus:review-release", (payload: Uint8Array) => {
  const request = JSON.parse(decodeUtf8(payload)) as ReleaseReviewRequest;
  return Promise.resolve(encodeUtf8(JSON.stringify(reviewRelease(request))));
});

ipc.handle("proc:run", (payload: Uint8Array) => {
  return new Promise<Uint8Array>((resolve, reject) => {
    const parts = decodeUtf8(payload).split("\n");
    const cmd = parts[0] ?? "";
    const args: string[] = [];
    for (let i = 1; i < parts.length; i++) args.push(parts[i]!);
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout!.on("data", (d: Buffer) => { out = out + decodeUtf8(bufToBytes(d)); });
    child.stderr!.on("data", (d: Buffer) => { err = err + decodeUtf8(bufToBytes(d)); });
    child.on("error", (e: Error) => { reject(e); });
    child.on("exit", (code: number | null) => {
      resolve(encodeUtf8((code ?? 0) === 0 ? out : "exit " + (code ?? 0) + "\n" + err));
    });
  });
});

function bufToBytes(d: Buffer): Uint8Array {
  const u = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) u[i] = d[i]!;
  return u;
}

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
      NT_BLOCKING_RUN: process.env.NT_BLOCKING_RUN ?? "",
    },
  });
  renderer.on("exit", (code: number | null) => {
    process.exit(code ?? 0);
  });
});
