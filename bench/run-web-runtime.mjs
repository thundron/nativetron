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
const CLICKS = 2000;
const TRIALS = Number(process.env.TRIALS ?? 100);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "nt-chrome-"));
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
    const out = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (out.result?.exceptionDetails) throw new Error(`${page}: ${JSON.stringify(out.result.exceptionDetails).slice(0, 200)}`);
    return out.result.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://localhost:${PORT}/bench/web-runtime/${page}` });
  for (let i = 0; i < 80; i++) { if (await evaluate("!!window.__benchReady")) break; await sleep(250); }
  await evaluate("window.__setup()", true);
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
  const ntT = [], rxT = [];
  for (let i = 0; i < TRIALS; i++) {
    ntT.push(await nt.evaluate(`window.__trial(${CLICKS})`));
    rxT.push(await rx.evaluate(`window.__trial(${CLICKS})`));
  }
  const ntS = await nt.evaluate("window.__stats()");
  const rxS = await rx.evaluate("window.__stats()");
  await nt.close(); await rx.close();

  const diffs = ntT.map((v, i) => v - rxT[i]);
  const ntWins = diffs.filter((d) => d < 0).length;
  const z = (ntWins - TRIALS / 2) / Math.sqrt(TRIALS / 4);
  const p = 2 * (1 - 0.5 * (1 + Math.sign(Math.abs(z)) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI))));

  console.log(`# nativetron (wasm) vs React — in-browser runtime\n`);
  console.log(`Headless Chrome (CDP). ${TRIALS} interleaved trials x ${CLICKS} real DOM clicks each.`);
  console.log(`Per-click microseconds; both stacks driven through their own event path.\n`);
  console.log(`| statistic | nativetron | react |`);
  console.log(`|---|---|---|`);
  console.log(`| median | ${f(median(ntT))} µs | ${f(median(rxT))} µs |`);
  console.log(`| mean | ${f(mean(ntT))} µs | ${f(mean(rxT))} µs |`);
  console.log(`| stddev | ${f(sd(ntT))} µs | ${f(sd(rxT))} µs |`);
  console.log(`| min | ${f(Math.min(...ntT))} µs | ${f(Math.min(...rxT))} µs |`);
  console.log(`| p95 | ${f(quantile(ntT, 0.95))} µs | ${f(quantile(rxT, 0.95))} µs |`);
  console.log(`| max | ${f(Math.max(...ntT))} µs | ${f(Math.max(...rxT))} µs |`);
  console.log(`\n| paired comparison | value |`);
  console.log(`|---|---|`);
  console.log(`| median paired diff (nt - react) | ${f(median(diffs))} µs |`);
  console.log(`| nativetron faster in | ${ntWins}/${TRIALS} trials |`);
  console.log(`| sign-test p (approx) | ${p < 0.001 ? "<0.001" : p.toFixed(3)} |`);
  console.log(`\n| memory / size | nativetron | react |`);
  console.log(`|---|---|---|`);
  console.log(`| JS heap | ${ntS.jsHeapMB} MB | ${rxS.jsHeapMB} MB |`);
  console.log(`| wasm linear memory | ${ntS.wasmMemMB} MB | — |`);
  console.log(`| module size | ${ntS.wasmKB} KB | 189.7 KB |`);
  console.log(`| final DOM state | ${ntS.finalCount} | ${rxS.finalCount} |`);
} finally {
  chrome.kill(); server.kill(); await sleep(600);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
