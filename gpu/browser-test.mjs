import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const server = createServer((request, response) => {
  const path = resolve(here, "." + new URL(request.url, "http://local").pathname);
  if (!path.startsWith(here + sep)) { response.writeHead(403).end(); return; }
  try {
    const body = readFileSync(path);
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Content-Type", ({ ".wasm": "application/wasm", ".mjs": "text/javascript", ".js": "text/javascript", ".html": "text/html" })[extname(path)] ?? "application/octet-stream");
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const profile = mkdtempSync(resolve(tmpdir(), "nt-gpu-chrome-"));
const chrome = spawn(process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--enable-unsafe-webgpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let ws;
let output = "";
chrome.stderr.on("data", (chunk) => { output += chunk; });
try {
  let cdp;
  for (let i = 0; i < 150; i++) {
    try { cdp = Number(readFileSync(resolve(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); break; } catch {}
    if (chrome.exitCode !== null) throw new Error(output);
    await delay(100);
  }
  if (!cdp) throw new Error("Chrome did not start: " + output);
  const target = await (await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/page.html` });
  let result;
  for (let i = 0; i < 300; i++) {
    result = await evaluate("window.demo ? ({ reports: demo.reports, events: demo.events, idle: demo.host.idle, frames: demo.host.stats.frames, uploadedBytes: demo.host.stats.uploadedBytes }) : null");
    if (result?.reports.some((line) => line.startsWith("GPU_READBACK_") || line.startsWith("GPU_UNAVAILABLE") || line.startsWith("GPU_ERROR"))) break;
    await delay(100);
  }
  console.log(JSON.stringify(result, null, 2));
  assert.ok(result?.reports.includes("GPU_READBACK_OK 4096"), "real GPU compute/readback acceptance did not pass");
  assert.equal(result.uploadedBytes, 16777216);
  assert.equal(result.events.filter((event) => event.status && event.type !== 7).length, 0, "GPU errors");
  assert.equal(result.idle, true);
  const frames = result.frames;
  await delay(500);
  assert.equal(await evaluate("demo.host.stats.frames"), frames, "idle host scheduled a frame");
  await evaluate("demo.message(1)");
  await delay(250);
  assert.equal(await evaluate("demo.host.stats.frames"), frames + 1);
  await evaluate(`(() => {
    demo.host.createShaderModule(1948577, 900, "@compute @workgroup_size(1)\\nfn broken() { invalid token; }", "intentional compile failure");
  })()`);
  await delay(500);
  const shader = await evaluate("demo.events.find(event => event.type === 7 && event.requestId === 900)");
  assert.equal(shader?.status, 1);
  assert.ok(shader.messages.some((message) => message.type === "error" && message.lineNum === 2));
  const measurements = await evaluate("import('./measure.js').then(module => module.measureGpu(demo))");
  console.log("GPU_MEASUREMENTS " + JSON.stringify(measurements));
  await evaluate("demo.host.device.destroy()");
  await delay(250);
  assert.equal(await evaluate("demo.events.some(event => event.type === 5)"), true);
  console.log("GPU: real compute + indirect draw + 16 MiB upload + 4 KiB readback + shader diagnostics + device loss + idle scheduling passed");
} finally {
  ws?.close();
  chrome.kill();
  await new Promise((done) => { if (chrome.exitCode !== null) done(); else chrome.once("exit", done); });
  await new Promise((done) => server.close(done));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
