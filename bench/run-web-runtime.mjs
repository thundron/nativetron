#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8231;
const CDP = 9231;
const N = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "nt-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--enable-precise-memory-info", "--js-flags=--expose-gc",
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

async function cdpTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
      const list = await r.json();
      if (list.length) return list;
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome CDP not reachable");
}

async function measure(page) {
  const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" });
  const target = await r.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://localhost:${PORT}/bench/web-runtime/${page}` });
  for (let i = 0; i < 80; i++) {
    const ready = await send("Runtime.evaluate", { expression: "!!window.__benchReady", returnByValue: true });
    if (ready.result?.result?.value === true) break;
    await sleep(250);
  }
  const out = await send("Runtime.evaluate", {
    expression: `window.__bench(${N})`,
    awaitPromise: true,
    returnByValue: true,
  });
  ws.close();
  await fetch(`http://127.0.0.1:${CDP}/json/close/${target.id}`);
  if (out.result?.exceptionDetails) throw new Error(`${page}: ${JSON.stringify(out.result.exceptionDetails).slice(0, 300)}`);
  return out.result.result.value;
}

try {
  await cdpTargets();
  const nt = await measure("nativetron.html");
  const rx = await measure("react.html");
  const ratio = (a, b) => (a && b ? `${(b / a).toFixed(2)}×` : "n/a");
  console.log("# nativetron (wasm) vs React — in-browser runtime\n");
  console.log(`Headless Chrome (CDP), ${N} real DOM clicks through each stack's own event path.\n`);
  console.log("| metric | nativetron | react | react / nativetron |");
  console.log("|---|---|---|---|");
  console.log(`| total, ${N} clicks | ${nt.totalMs} ms | ${rx.totalMs} ms | ${ratio(nt.totalMs, rx.totalMs)} |`);
  console.log(`| per click | ${nt.perClickUs} µs | ${rx.perClickUs} µs | ${ratio(nt.perClickUs, rx.perClickUs)} |`);
  console.log(`| JS heap after | ${nt.jsHeapMB} MB | ${rx.jsHeapMB} MB | ${ratio(nt.jsHeapMB, rx.jsHeapMB)} |`);
  console.log(`| JS heap delta | ${nt.jsHeapDeltaMB} MB | ${rx.jsHeapDeltaMB} MB | — |`);
  console.log(`| wasm linear memory | ${nt.wasmMemMB} MB | — | — |`);
  console.log(`| module size | ${nt.wasmKB} KB | 189.7 KB | — |`);
  console.log(`| final DOM state | ${nt.finalCount} | ${rx.finalCount} | — |`);
} finally {
  chrome.kill();
  server.kill();
  await sleep(600);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
