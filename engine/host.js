import { loadReactor } from "./reactor.js";
import { decodeEngineMessage, ENGINE_MAX_RATE, LANE_ENGINE, LANE_NATIVE, LANE_UI } from "../ipc/engine.generated.mjs";

export async function startEngine(options) {
  const { canvas, report = console.log, postNative = () => {}, postUi = () => {} } = options;
  let worker, reactor, disposed = false, observer, media;
  const scope = options.scope ?? globalThis;
  let windowStart = performance.now(), messages = 0;
  const route = (bytes) => {
    const frame = decodeEngineMessage(bytes);
    if (!frame || frame.source !== LANE_ENGINE) throw new Error("invalid engine source");
    if (frame.target === LANE_NATIVE) postNative(bytes);
    else if (frame.target === LANE_UI) postUi(bytes);
  };
  const probe = async () => {
    if (!scope.Worker || !canvas.transferControlToOffscreen) return { available: false, reason: "Worker or OffscreenCanvas unavailable" };
    worker = new scope.Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    return await new Promise((resolve) => {
      const finish = (value) => { clearTimeout(timeout); worker.onmessage = null; worker.onerror = null; resolve(value); };
      const timeout = setTimeout(() => finish({ available: false, reason: "worker probe timed out" }), 5000);
      worker.onerror = () => finish({ available: false, reason: "module Worker could not start" });
      worker.onmessage = ({ data }) => { if (data.type === "probe") finish(data); };
      worker.postMessage({ type: "probe" });
    });
  };
  let capability;
  try { capability = options.forceMain ? { available: false, reason: "main thread requested" } : await probe(); }
  catch (error) { capability = { available: false, reason: String(error) }; }
  const mode = capability.available ? "worker" : "main";
  if (mode === "worker") {
    const offscreen = canvas.transferControlToOffscreen();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("engine worker startup timed out after canvas transfer")), 15000);
      worker.onerror = () => { clearTimeout(timeout); reject(new Error("engine worker failed")); };
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") { clearTimeout(timeout); resolve(); }
        else if (data.type === "report") report(data.message);
        else if (data.type === "message") route(data.bytes);
        else if (data.type === "gpu-event") options.onEvent?.(data.event);
        else if (data.type === "error") { clearTimeout(timeout); report("ENGINE_ERROR " + data.message); reject(new Error(data.message)); }
      };
      worker.postMessage({ type: "start", canvas: offscreen, options: { moduleUrl: options.moduleUrl, wasmUrl: options.wasmUrl, prefix: options.prefix } }, [offscreen]);
    }).catch((error) => { worker.terminate(); throw error; });
  } else {
    worker?.terminate(); worker = null;
    reactor = await loadReactor({ ...options, post: route });
  }
  report(`ENGINE_MODE ${mode}${capability.reason ? " (" + capability.reason + ")" : ""}`);
  const resize = () => {
    if (disposed || !worker) return;
    const dpr = scope.devicePixelRatio ?? 1;
    worker.postMessage({ type: "resize", width: Math.max(1, Math.round(canvas.clientWidth * dpr)), height: Math.max(1, Math.round(canvas.clientHeight * dpr)), dpr });
  };
  const watchDpr = () => {
    if (!scope.matchMedia || !worker) return;
    media?.removeEventListener("change", changedDpr);
    media = scope.matchMedia(`(resolution: ${scope.devicePixelRatio ?? 1}dppx)`);
    media.addEventListener("change", changedDpr, { once: true });
  };
  const changedDpr = () => { resize(); watchDpr(); };
  if (worker && scope.ResizeObserver) { observer = new scope.ResizeObserver(resize); observer.observe(canvas); resize(); watchDpr(); }
  return {
    mode, reason: capability.reason ?? "", reactor,
    send(bytes, source = LANE_UI) {
      if (disposed) throw new Error("engine lane disposed");
      const frame = decodeEngineMessage(bytes);
      if (!frame || frame.source !== source || frame.target !== LANE_ENGINE) throw new Error("invalid engine message route");
      const now = performance.now();
      if (now - windowStart >= 1000) { windowStart = now; messages = 0; }
      if (++messages > ENGINE_MAX_RATE) throw new Error("engine control rate exceeded");
      if (worker) { const copy = bytes.slice(); worker.postMessage({ type: "message", bytes: copy }, [copy.buffer]); }
      else reactor.receive(bytes);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect(); media?.removeEventListener("change", changedDpr);
      worker?.postMessage({ type: "stop" }); worker?.terminate();
      reactor?.dispose();
    },
  };
}
