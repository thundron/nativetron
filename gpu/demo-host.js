import { instantiateFromBytes } from "./.scriptc/demo.mjs";
import { createGpuHost } from "./host.js";

export async function loadGpuDemo(canvas, report = console.log) {
  let api;
  let uploadSource = null;
  let benchmarkObserver = () => {};
  const events = [], reports = [], messages = [];
  // Events always enter on a later microtask, never recursively during a wasm import.
  const host = createGpuHost({
    canvas,
    getMemory: () => api.__memory(),
    onFrame: (time) => api.ntgpu_frame(time),
    onEvent: (event) => {
      events.push(event);
      queueMicrotask(() => {
        if (event.data) api.ntgpu_readback(event.offset, event.data);
        let text = event.message ?? event.reason ?? "";
        let value = 0;
        if (event.type === 1 && event.available) {
          text = JSON.stringify(event);
          value = event.features.includes("timestamp-query") ? 1 : 0;
          report("GPU_CAPABILITIES " + JSON.stringify(event));
        } else if (event.type === 7) text = JSON.stringify(event.messages);
        else if (event.type === 8) { value = event.dpr; text = JSON.stringify({ width: event.width, height: event.height }); }
        api.ntgpu_event(event.type, event.requestId, event.handle, event.status, value, text);
      });
    },
  });
  const response = await fetch(new URL("./.scriptc/demo.wasm", import.meta.url));
  if (!response.ok) throw new Error(`GPU reactor HTTP ${response.status}`);
  api = await instantiateFromBytes(await response.arrayBuffer(), {
    gpuPresent: (batch, uploads, readbacks) => {
      if (uploads.byteLength) uploadSource = { offset: uploads.byteOffset, length: uploads.byteLength };
      return host.apply(batch, uploads, readbacks);
    },
    gpuReport: (message) => { reports.push(message); report(message); },
    engineSend: frame => messages.push(frame.slice()),
    gpuBenchmark: bytes => benchmarkObserver(bytes),
  });
  const initialMemoryBytes = api.__memory().byteLength;
  api.ntgpu_start();
  return { api, host, events, reports, messages, initialMemoryBytes, setBenchmarkObserver: fn => { benchmarkObserver = fn; }, get uploadSource() { return uploadSource; }, message: (kind, bytes = new Uint8Array()) => api.ntgpu_message(kind, bytes), dispose: () => host.dispose() };
}
