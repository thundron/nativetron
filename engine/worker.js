import { EngineError, errorText, instantiateReactor, prepareReactor } from "./reactor.js";

// Protocol (host → worker): probe, prepare, start, restart, message, resize, stop.
// Protocol (worker → host): probe, prepared, ready, error, report, message, gpu-event, credit, failed, stopped.
// Every post-start message carries the generation it belongs to; anything for another generation is ignored.
const scope = self;
let prepared = null, preparing = null, reactor = null, canvas = null, generation = 0, pixelRatio = 1, stopping = false;
let credits = 0, creditQueued = false;

const send = (message, transfer) => { if (!stopping) scope.postMessage(message, transfer); };
const credit = (gen, count) => {
  credits += count;
  if (creditQueued) return;
  creditQueued = true;
  queueMicrotask(() => {
    creditQueued = false;
    const count = credits; credits = 0;
    if (count && gen === generation) send({ type: "credit", generation: gen, count });
  });
};

async function probe() {
  let device;
  try {
    if (!scope.navigator?.gpu || !scope.OffscreenCanvas || !scope.requestAnimationFrame || !scope.WebAssembly) throw new Error("worker WebGPU, OffscreenCanvas or rAF absent");
    const adapter = await scope.navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("worker adapter unavailable");
    device = await adapter.requestDevice();
    const context = new scope.OffscreenCanvas(1, 1).getContext("webgpu");
    if (!context) throw new Error("worker WebGPU context unavailable");
    context.configure({ device, format: scope.navigator.gpu.getPreferredCanvasFormat() });
    context.getCurrentTexture(); context.unconfigure();
    send({ type: "probe", available: true });
  } catch (error) { send({ type: "probe", available: false, reason: errorText(error) }); }
  finally { device?.destroy(); }
}

async function prepare(options) {
  try {
    preparing = prepareReactor(options ?? {});
    prepared = await preparing;
    send({ type: "prepared", ok: true });
  } catch (error) { prepared = null; send({ type: "prepared", ok: false, code: error.code ?? "prepare-failed", reason: errorText(error) }); }
  finally { preparing = null; }
}

async function launch(gen) {
  if (preparing) await preparing.catch(() => {});
  if (!prepared) throw new EngineError("not-prepared", "engine worker was not prepared");
  if (!canvas) throw new EngineError("no-canvas", "engine worker has no OffscreenCanvas");
  const current = () => gen === generation && !stopping;
  const created = await instantiateReactor(prepared, {
    canvas, pixelRatio, scope,
    cancelled: () => !current(),
    report: (message) => { if (current()) send({ type: "report", generation: gen, message }); },
    post: (bytes) => { if (current()) send({ type: "message", generation: gen, bytes }, [bytes.buffer]); },
    onEvent: (event) => { if (current()) send({ type: "gpu-event", generation: gen, event }); },
    onFailure: (error) => { if (current()) send({ type: "failed", generation: gen, code: error.code ?? "engine-failed", message: errorText(error) }); },
    onConsumed: (count) => { if (current()) credit(gen, count); },
  });
  if (!current()) { created.dispose(); return; }
  reactor = created;
  send({ type: "ready", generation: gen });
}

function begin(gen) {
  if (!Number.isInteger(gen) || gen <= generation) { send({ type: "error", generation: gen, code: "invalid-generation", message: "engine worker generation must increase" }); return; }
  const previous = reactor;
  reactor = null; generation = gen; credits = 0;
  try { previous?.dispose(); } catch {}
  launch(gen).catch((error) => { if (gen === generation && !stopping) send({ type: "error", generation: gen, code: error.code ?? "start-failed", message: errorText(error) }); });
}

function stop() {
  if (stopping) return;
  const previous = reactor;
  reactor = null; generation = Infinity;
  let message = "";
  try { previous?.dispose(); } catch (error) { message = errorText(error); }
  scope.postMessage({ type: "stopped", ok: !message, message });
  stopping = true;
  scope.close();
}

scope.onmessage = ({ data }) => {
  if (stopping || !data || typeof data.type !== "string") return;
  try {
    switch (data.type) {
      case "probe": probe(); break;
      case "prepare": prepare(data.options); break;
      case "start":
        if (canvas) { send({ type: "error", generation: data.generation, code: "already-started", message: "engine worker already owns a canvas" }); break; }
        canvas = data.canvas ?? null; pixelRatio = data.options?.pixelRatio ?? 1;
        begin(data.generation);
        break;
      case "restart":
        if (Number.isFinite(data.options?.pixelRatio)) pixelRatio = data.options.pixelRatio;
        begin(data.generation);
        break;
      case "message":
        if (data.generation !== generation) break;
        try { if (!reactor) throw new EngineError("not-ready", "engine worker has no live reactor"); reactor.receive(data.bytes); }
        catch { credit(generation, 1); }
        break;
      case "resize":
        if (data.generation === generation) { pixelRatio = data.dpr; reactor?.resize(data.width, data.height, data.dpr); }
        break;
      case "stop": stop(); break;
    }
  } catch (error) { send({ type: "failed", generation, code: "worker-protocol", message: errorText(error) }); }
};
