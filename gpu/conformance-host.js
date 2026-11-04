import { createGpuHost } from "./host.js";

// Loads the conformance reactor against a GPU host. Every event is recorded before it is delivered to
// the guest on a later microtask, never during a wasm import.
export async function loadConformance({ canvas, bytes, moduleUrl = new URL("./.scriptc/conformance.mjs", import.meta.url).href, report = () => {}, observe = () => {}, host: hostOptions = {} }) {
  let api;
  const events = [], reports = [];
  const { instantiateFromBytes } = await import(moduleUrl);
  const host = createGpuHost({
    canvas,
    getMemory: () => api.__memory(),
    onEvent: (event) => {
      events.push(event);
      observe(event);
      queueMicrotask(() => {
        const value = event.type === 1 ? event.featureBits ?? 0 : 0;
        api.ntconf_event(event.type, event.requestId, event.handle, event.status, value, JSON.stringify(event));
      });
    },
    ...hostOptions,
  });
  if (!bytes) {
    const response = await fetch(new URL("./.scriptc/conformance.wasm", import.meta.url));
    if (!response.ok) throw new Error(`conformance reactor HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
  }
  api = await instantiateFromBytes(bytes, {
    gpuPresent: (batch, uploads, readbacks) => host.apply(batch, uploads, readbacks),
    gpuReport: (message) => { reports.push(message); report(message); },
  });
  api.ntconf_start();
  return { api, host, events, reports, step: (phase) => api.ntconf_step(phase), dispose: () => host.dispose() };
}
