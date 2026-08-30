import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8244, CDP = 9264;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: here, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "ntc-"));
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const done = (code) => { chrome.kill(); server.kill(); process.exit(code); };
try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/list`); if ((await r.json()).length) break; } catch {} await sleep(250); }
  const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/page.html` });
  await sleep(1500);
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception ?? r.result.exceptionDetails)); return r.result.result.value; };
  const size = await ev("window.__init()");
  let bad = 0;
  for (const frame of [0, 7, 33, 120]) {
    const r = JSON.parse(await ev(`window.__compare(${frame})`));
    const ok = r.differingSubpixels === 0;
    if (!ok) bad++;
    console.log(`  frame ${String(frame).padStart(3)}  differing subpixels: ${r.differingSubpixels}  maxDelta: ${r.maxDelta}  (${r.bytes} B/frame)`);
  }
  console.log(bad === 0 ? `  compiled canvas is pixel-identical to the direct DOM calls (module ${(size/1024).toFixed(1)} KB)` : "  PIXEL MISMATCH");
  const b = JSON.parse(await ev("window.__bench(200)"));
  console.log(`  demo scene (~90 ops)  compiled ${b.compiledMs} ms   direct JS ${b.directMs} ms`);
  for (const n of [1000, 5000, 20000]) {
    const h = JSON.parse(await ev(`window.__heavy(${n}, 60)`));
    if (h.differingSubpixels !== 0) { console.log(`  ${n} rects: PIXEL MISMATCH (${h.differingSubpixels})`); bad++; }
    console.log(`  ${String(n).padStart(5)} rects/frame  compiled ${String(h.compiledMs).padStart(6)} ms   direct JS ${String(h.directMs).padStart(6)} ms   x${(h.compiledMs/h.directMs).toFixed(2)}`);
  }
  done(bad === 0 ? 0 : 1);
} catch (e) { console.error("  FAILED:", e.message); done(1); }
