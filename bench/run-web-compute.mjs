#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8241;
const CDP = 9241;
const ROWS = Number(process.env.ROWS ?? 10000);
const TRIALS = Number(process.env.TRIALS ?? 50);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "nt-chrome-c-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--enable-precise-memory-info",
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/list`); if ((await r.json()).length) return; } catch {}
    await sleep(250);
  }
  throw new Error("chrome CDP not reachable");
}

async function openPage(page) {
  const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" });
  const target = await r.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression, awaitPromise = false) => {
    const out = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 120000 });
    if (out.result?.exceptionDetails) throw new Error(`${page}: ${JSON.stringify(out.result.exceptionDetails).slice(0, 300)}`);
    return out.result.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://localhost:${PORT}/bench/web-compute/${page}` });
  for (let i = 0; i < 120; i++) { if (await evaluate("!!window.__benchReady")) break; await sleep(250); }
  return { evaluate, close: async () => { ws.close(); await fetch(`http://127.0.0.1:${CDP}/json/close/${target.id}`); } };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };
const f = (x) => x.toFixed(2);

try {
  await waitCdp();
  const nt = await openPage("nativetron.html");
  const rx = await openPage("react.html");
  const ntT0 = Date.now();
  const ntRows = await nt.evaluate(`window.__setup(${ROWS})`, true);
  const ntMount = Date.now() - ntT0;
  const rxT0 = Date.now();
  const rxRows = await rx.evaluate(`window.__setup(${ROWS})`, true);
  const rxMount = Date.now() - rxT0;
  for (let i = 0; i < 3; i++) { await nt.evaluate("window.__trial()"); await rx.evaluate("window.__trial()"); }
  const ntT = [], rxT = [];
  for (let i = 0; i < TRIALS; i++) {
    ntT.push(await nt.evaluate("window.__trial()"));
    rxT.push(await rx.evaluate("window.__trial()"));
  }
  const ntS = await nt.evaluate("window.__stats()");
  const rxS = await rx.evaluate("window.__stats()");
  await nt.close(); await rx.close();

  const diffs = ntT.map((v, i) => v - rxT[i]);
  const wins = diffs.filter((d) => d < 0).length;
  const z = (wins - TRIALS / 2) / Math.sqrt(TRIALS / 4);
  const p = 2 * (1 - 0.5 * (1 + Math.sqrt(1 - Math.exp((-2 * z * z) / Math.PI))));

  console.log(`# nativetron (wasm) vs React — compute-heavy workload\n`);
  console.log(`${ROWS} rows. One update = ${ROWS} arithmetic ops + sort of ${ROWS} + ${ROWS} string builds`);
  console.log(`+ ${ROWS} DOM text updates. ${TRIALS} interleaved trials, synchronous render both sides.\n`);
  console.log(`| statistic (ms per update) | nativetron | react |`);
  console.log(`|---|---|---|`);
  console.log(`| median | ${f(median(ntT))} | ${f(median(rxT))} |`);
  console.log(`| mean | ${f(mean(ntT))} | ${f(mean(rxT))} |`);
  console.log(`| stddev | ${f(sd(ntT))} | ${f(sd(rxT))} |`);
  console.log(`| min | ${f(Math.min(...ntT))} | ${f(Math.min(...rxT))} |`);
  console.log(`| p95 | ${f(quantile(ntT, 0.95))} | ${f(quantile(rxT, 0.95))} |`);
  console.log(`| max | ${f(Math.max(...ntT))} | ${f(Math.max(...rxT))} |`);
  console.log(`\n| paired | value |`);
  console.log(`|---|---|`);
  console.log(`| median paired diff (nt - react) | ${f(median(diffs))} ms |`);
  console.log(`| speedup (react / nativetron, medians) | ${(median(rxT) / median(ntT)).toFixed(2)}× |`);
  console.log(`| nativetron faster in | ${wins}/${TRIALS} trials |`);
  console.log(`| sign-test p (approx) | ${p < 0.001 ? "<0.001" : p.toFixed(3)} |`);
  console.log(`\n| context | nativetron | react |`);
  console.log(`|---|---|---|`);
  console.log(`| rows rendered | ${ntRows} | ${rxRows} |`);
  console.log(`| mount ${ROWS} rows | ${ntMount} ms | ${rxMount} ms |`);
  console.log(`| mount ${ROWS} rows (incl. fetch/instantiate) | ${ntMount} ms | ${rxMount} ms |`);
  console.log(`| JS heap | ${ntS.jsHeapMB} MB | ${rxS.jsHeapMB} MB |`);
  console.log(`| wasm linear memory | ${ntS.wasmMemMB} MB | — |`);
  console.log(`| module size | ${ntS.wasmKB} KB | 189.8 KB |`);
  console.log(`| first row after run | ${JSON.stringify(ntS.sample)} | ${JSON.stringify(rxS.sample)} |`);
} finally {
  chrome.kill(); server.kill(); await sleep(600);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
