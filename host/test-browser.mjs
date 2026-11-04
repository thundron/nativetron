import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";

export async function testBrowser(root) {
  const delay = (ms) => new Promise((done) => setTimeout(done, ms));
  const server = createServer((request, response) => {
    const path = resolve(root, "." + new URL(request.url, "http://local").pathname);
    if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    try {
      const body = readFileSync(path);
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      response.setHeader("Content-Type", ({ ".wasm": "application/wasm", ".mjs": "text/javascript", ".js": "text/javascript", ".html": "text/html" })[extname(path)] ?? "application/octet-stream");
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const profile = mkdtempSync(resolve(tmpdir(), "nt-browser-"));
  const chrome = spawn(process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--enable-unsafe-webgpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let output = "", launchError, ws, closed = false;
  chrome.on("error", (error) => { launchError = error; });
  chrome.stderr.on("data", (chunk) => { output += chunk; });
  const close = async () => {
    if (closed) return;
    closed = true; ws?.close(); chrome.kill();
    if (chrome.exitCode === null && !launchError) await new Promise((done) => chrome.once("exit", done));
    await new Promise((done) => server.close(done));
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    let cdp;
    for (let i = 0; i < 150; i++) {
      if (launchError) throw launchError;
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
    const diagnostics = [];
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data), request = pending.get(message.id);
      if (message.method === "Runtime.exceptionThrown" || message.method === "Log.entryAdded") diagnostics.push(message.params);
      if (request) { pending.delete(message.id); clearTimeout(request.timeout); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    return {
      delay, send, close, diagnostics,
      navigate: (path) => send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}${path}` }),
      async evaluate(expression) {
        const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      },
    };
  } catch (error) { await close(); throw error; }
}
