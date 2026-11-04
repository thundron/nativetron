import { createGpuHost } from "../gpu/host.js";
import { decodeEngineMessage, encodeEngineMessage, ENGINE_REPORT, LANE_ENGINE, LANE_NATIVE } from "../ipc/engine.generated.mjs";

export async function loadReactor(options) {
  const { canvas, moduleUrl, wasmUrl, prefix, report = console.log, post = () => {} } = options;
  let api, disposed = false;
  const queued = [];
  const deliver = (event) => {
    if (disposed) return;
    let value = 0, text = event.message ?? event.reason ?? "";
    if (event.type === 1 && event.available) { value = event.features.includes("timestamp-query") ? 1 : 0; text = JSON.stringify(event); }
    else if (event.type === 7) text = JSON.stringify(event.messages);
    else if (event.type === 8) { value = event.dpr; text = JSON.stringify({ width: event.width, height: event.height }); }
    api[`${prefix}event`](event.type, event.requestId, event.handle, event.status, value, text);
    options.onEvent?.(event);
  };
  const host = createGpuHost({
    canvas, scope: options.scope ?? globalThis,
    getMemory: () => api.__memory(),
    onFrame: (time) => api[`${prefix}frame`](time),
    onEvent: (event) => { queued.push(event); queueMicrotask(() => { if (api && !disposed) { while (queued.length) deliver(queued.shift()); } }); },
  });
  try {
    const module = await import(moduleUrl);
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`engine reactor HTTP ${response.status}`);
    api = await module.instantiateFromBytes(await response.arrayBuffer(), {
      gpuPresent: (batch, uploads, readbacks) => host.apply(batch, uploads, readbacks),
      gpuReport: (message) => {
        report(message);
        const payload = new TextEncoder().encode(message);
        post(encodeEngineMessage(ENGINE_REPORT, LANE_ENGINE, LANE_NATIVE, 0, 0, payload));
      },
      engineSend: (bytes) => {
        const message = decodeEngineMessage(bytes);
        if (!message || message.source !== LANE_ENGINE) throw new Error("invalid outbound engine message");
        post(bytes.slice());
      },
    });
    while (queued.length) deliver(queued.shift());
    api[`${prefix}start`]();
    return {
      api, host,
      receive(bytes) {
        const message = decodeEngineMessage(bytes);
        if (!message || message.target !== LANE_ENGINE) throw new Error("invalid engine destination");
        api[`${prefix}message`](message.topic, message.payload);
      },
      resize(width, height, dpr) {
        canvas.width = width; canvas.height = height;
        deliver({ type: 8, requestId: 0, handle: 0, status: 0, width, height, dpr });
      },
      dispose() { disposed = true; queued.length = 0; host.dispose(); },
    };
  } catch (error) { disposed = true; host.dispose(); throw error; }
}
