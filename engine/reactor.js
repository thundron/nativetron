import { createGpuHost } from "../gpu/host.js";
import { decodeEngineMessage, encodeEngineMessage, ENGINE_MAX_PAYLOAD, ENGINE_MAX_RATE, ENGINE_REPORT, LANE_ENGINE, LANE_NATIVE, LANE_UI } from "../ipc/engine.generated.mjs";

// Per-instance bounds. Inbound control frames wait for the reactor to be idle; outbound frames wait for rate budget.
export const ENGINE_INBOUND_LIMIT = 64;
export const ENGINE_OUTBOUND_LIMIT = 64;
export const ENGINE_EVENT_LIMIT = 1024;
export const ENGINE_RATE_WINDOW_MS = 1000;
const REQUIRED_EXPORTS = ["start", "frame", "event", "message"];
const MAX_REPORT_UNITS = Math.floor(ENGINE_MAX_PAYLOAD / 3);

export class EngineError extends Error {
  constructor(code, message, details = {}) {
    const { cause, ...rest } = details;
    super(message, cause === undefined ? undefined : { cause });
    this.name = rest.name ?? "EngineError";
    delete rest.name;
    this.code = code;
    Object.assign(this, rest);
  }
}
export const errorText = (error) => error instanceof Error ? error.message : String(error);

// Sliding-window limiter: take() records and returns 0 when allowed, otherwise the milliseconds until budget frees.
export function createRateWindow(limit = ENGINE_MAX_RATE, windowMs = ENGINE_RATE_WINDOW_MS, now = () => performance.now()) {
  const stamps = [];
  const expire = (time) => { while (stamps.length && time - stamps[0] >= windowMs) stamps.shift(); };
  return {
    take() {
      const time = now();
      expire(time);
      if (stamps.length < limit) { stamps.push(time); return 0; }
      return Math.max(1, stamps[0] + windowMs - time);
    },
    get used() { expire(now()); return stamps.length; },
    reset() { stamps.length = 0; },
  };
}

// Bounded, rate-shaped outbound queue. Frames are delivered on a later microtask or timer, never inside the caller.
export function createOutbound(options) {
  const { deliver, onDrop = () => {}, limit = ENGINE_OUTBOUND_LIMIT } = options;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((token) => clearTimeout(token));
  const window = createRateWindow(options.rate ?? ENGINE_MAX_RATE, ENGINE_RATE_WINDOW_MS, options.now);
  const queue = [];
  let timer = null, scheduled = false, closed = false, dropped = 0, delivered = 0;
  const flush = () => {
    scheduled = false; timer = null;
    while (!closed && queue.length) {
      const wait = window.take();
      if (wait) { timer = setTimer(flush, wait); return; }
      delivered++;
      deliver(queue.shift());
    }
  };
  return {
    push(item) {
      if (closed) return false;
      if (queue.length >= limit) { dropped++; onDrop(dropped); return false; }
      queue.push(item);
      if (!scheduled && timer === null) { scheduled = true; queueMicrotask(flush); }
      return true;
    },
    get pending() { return queue.length; },
    get dropped() { return dropped; },
    get delivered() { return delivered; },
    get idle() { return queue.length === 0 && timer === null && !scheduled; },
    close() { closed = true; queue.length = 0; if (timer !== null) clearTimer(timer); timer = null; },
  };
}

export function wasmExportNames(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const names = new Set();
  const decoder = new TextDecoder();
  let at = 8;
  const leb = () => {
    let value = 0, shift = 0, byte;
    do {
      if (at >= view.length) throw new EngineError("wasm-invalid", "truncated WebAssembly module");
      byte = view[at++]; value += (byte & 0x7f) * 2 ** shift; shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (at < view.length) {
    const id = view[at++], size = leb(), end = at + size;
    if (id === 7) {
      for (let count = leb(); count > 0; count--) {
        const length = leb();
        names.add(decoder.decode(view.subarray(at, at + length)));
        at += length + 1; leb();
      }
    }
    at = end;
  }
  return names;
}

// Everything that can fail without touching a canvas: module import, wasm fetch, validation and export names.
export async function prepareReactor(options) {
  const { moduleUrl, wasmUrl, prefix = "" } = options;
  if (typeof prefix !== "string" || !/^[A-Za-z0-9_]*$/.test(prefix)) throw new EngineError("invalid-options", "engine prefix must contain only letters, digits and underscores");
  if (!moduleUrl || !wasmUrl) throw new EngineError("invalid-options", "engine moduleUrl and wasmUrl are required");
  let module;
  try { module = await import(String(moduleUrl)); }
  catch (error) { throw new EngineError("module-load-failed", `engine module could not be loaded: ${errorText(error)}`, { cause: error }); }
  if (typeof module.instantiateFromBytes !== "function") throw new EngineError("module-invalid", "engine module does not export instantiateFromBytes");
  const fetcher = options.fetch ?? globalThis.fetch;
  let response;
  try { response = await fetcher(String(wasmUrl)); }
  catch (error) { throw new EngineError("wasm-load-failed", `engine reactor could not be fetched: ${errorText(error)}`, { cause: error }); }
  if (!response.ok) throw new EngineError("wasm-load-failed", `engine reactor HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (!WebAssembly.validate(bytes)) throw new EngineError("wasm-invalid", "engine reactor is not a valid WebAssembly module");
  const names = wasmExportNames(bytes);
  const missing = ["memory", ...REQUIRED_EXPORTS.map((name) => prefix + name)].filter((name) => !names.has(name));
  if (missing.length) throw new EngineError("wasm-exports-missing", `engine reactor is missing exports: ${missing.join(", ")}`);
  return Object.freeze({ module, bytes, prefix });
}

// One prepared module may be instantiated many times; every instance owns a fresh GPU host and handle table.
export async function instantiateReactor(prepared, options) {
  const { canvas, report = console.log, post = () => {} } = options;
  const { prefix } = prepared;
  const scope = options.scope ?? globalThis;
  const inboundLimit = options.inboundLimit ?? ENGINE_INBOUND_LIMIT;
  let api = null, active = false, disposed = false, started = false, failure = null, draining = false, dropReportedAt = -Infinity;
  let pixelRatio = options.pixelRatio ?? 1;
  const now = options.now ?? (() => performance.now());
  const inbox = [];
  let inboxMessages = 0, inboxEvents = 0;
  const safe = (fn, ...args) => { try { fn?.(...args); } catch (error) { try { report(`ENGINE_CALLBACK_ERROR ${errorText(error)}`); } catch {} } };
  const outbound = createOutbound({
    now, setTimer: options.setTimer, clearTimer: options.clearTimer, limit: options.outboundLimit,
    deliver: (item) => { if (disposed) return; if (item.text !== undefined) safe(report, item.text); safe(post, item.frame); },
    onDrop: (count) => {
      const time = now();
      if (time - dropReportedAt < ENGINE_RATE_WINDOW_MS) return;
      dropReportedAt = time;
      queueMicrotask(() => safe(report, `ENGINE_ROUTE_DROPPED ${count} outbound frames (queue full)`));
    },
  });
  const host = createGpuHost({
    canvas, scope,
    getPixelRatio: () => canvas.clientWidth === undefined ? pixelRatio : (scope.devicePixelRatio ?? 1),
    getMemory: () => api.__memory(),
    onFrame: (time) => call("frame", time),
    onEvent: (event) => {
      if (disposed || failure) return;
      if (inboxEvents >= ENGINE_EVENT_LIMIT) { fail(new EngineError("event-overflow", "engine GPU event queue overflow")); return; }
      inbox.push({ event }); inboxEvents++; schedule();
    },
  });
  const fail = (error) => {
    if (failure || disposed) return;
    failure = error instanceof EngineError ? error : new EngineError("engine-failed", `engine instance failed: ${errorText(error)}`, { cause: error });
    inbox.length = 0; inboxMessages = 0; inboxEvents = 0;
    outbound.close(); host.dispose();
    if (started) queueMicrotask(() => safe(options.onFailure, failure));
  };
  // Every export call is guarded: nested calls are rejected and a throwing export discards the instance.
  const call = (name, ...args) => {
    if (active) throw new EngineError("reentry", `engine reactor reentry rejected (${name})`);
    if (failure || disposed || !api) return undefined;
    active = true;
    try { return api[prefix + name](...args); }
    catch (error) { active = false; fail(error); return undefined; }
    finally { active = false; }
  };
  const deliver = (event) => {
    let value = 0, text = event.message ?? event.reason ?? "";
    if (event.type === 1 && event.available) { value = event.features.includes("timestamp-query") ? 1 : 0; text = JSON.stringify(event); }
    else if (event.type === 7) text = JSON.stringify(event.messages);
    else if (event.type === 8) { value = event.dpr; text = JSON.stringify({ width: event.width, height: event.height }); }
    call("event", event.type, event.requestId, event.handle, event.status, value, text);
    if (!failure && !disposed) safe(options.onEvent, event);
  };
  const drain = () => {
    draining = false;
    if (!api || disposed || failure) return;
    if (active) { schedule(); return; }
    let consumed = 0;
    while (inbox.length && !failure && !disposed) {
      const item = inbox.shift();
      if (item.event) { inboxEvents--; deliver(item.event); }
      else { inboxMessages--; consumed++; call("message", item.topic, item.payload); }
    }
    if (consumed) safe(options.onConsumed, consumed);
  };
  function schedule() { if (!draining) { draining = true; queueMicrotask(drain); } }
  const encoder = new TextEncoder();
  const imports = {
    gpuPresent: (batch, uploads, readbacks) => host.apply(batch, uploads, readbacks),
    gpuReport: (message) => {
      if (failure || disposed) return;
      let text = String(message);
      if (text.length > MAX_REPORT_UNITS) text = text.slice(0, MAX_REPORT_UNITS - 1) + "…";
      outbound.push({ text, frame: encodeEngineMessage(ENGINE_REPORT, LANE_ENGINE, LANE_NATIVE, 0, 0, encoder.encode(text)) });
    },
    engineSend: (bytes) => {
      const message = decodeEngineMessage(bytes);
      if (!message || message.source !== LANE_ENGINE || (message.target !== LANE_NATIVE && message.target !== LANE_UI)) throw new EngineError("invalid-route", "invalid outbound engine message");
      if (!failure && !disposed) outbound.push({ frame: bytes.slice() });
    },
    panic: (message) => { throw new EngineError("engine-panic", `engine panic: ${message}`); },
  };
  const abandon = () => { disposed = true; inbox.length = 0; outbound.close(); host.dispose(); };
  try { api = await prepared.module.instantiateFromBytes(prepared.bytes, imports); }
  catch (error) { abandon(); throw new EngineError("instantiate-failed", `engine reactor instantiation failed: ${errorText(error)}`, { cause: error }); }
  if (options.cancelled?.()) { abandon(); throw new EngineError("aborted", "engine start cancelled", { name: "AbortError" }); }
  drain();
  if (!failure) call("start");
  if (failure) { const cause = failure; abandon(); throw new EngineError("start-failed", `engine start failed: ${cause.message}`, { cause }); }
  started = true;
  return {
    api, host,
    get failed() { return failure; },
    get disposed() { return disposed; },
    get pending() { return inboxMessages; },
    get outbound() { return { pending: outbound.pending, dropped: outbound.dropped, delivered: outbound.delivered }; },
    receive(bytes) {
      const message = bytes instanceof Uint8Array ? decodeEngineMessage(bytes) : null;
      if (!message || message.target !== LANE_ENGINE) throw new Error("invalid engine destination");
      if (disposed) throw new EngineError("disposed", "engine reactor disposed");
      if (failure) throw new EngineError("failed", `engine reactor failed: ${failure.message}`, { cause: failure });
      if (inboxMessages >= inboundLimit) throw new EngineError("queue-full", "engine inbound queue full");
      inbox.push({ topic: message.topic, payload: message.payload.slice() }); inboxMessages++; schedule();
    },
    resize(width, height, dpr) {
      if (disposed || failure) return;
      if (![width, height, dpr].every(Number.isFinite) || width < 1 || height < 1 || dpr <= 0) return;
      width = Math.round(width); height = Math.round(height);
      canvas.width = width; canvas.height = height; pixelRatio = dpr;
      if (inboxEvents >= ENGINE_EVENT_LIMIT) { fail(new EngineError("event-overflow", "engine GPU event queue overflow")); return; }
      inbox.push({ event: { type: 8, requestId: 0, handle: 0, status: 0, width, height, dpr } }); inboxEvents++; schedule();
    },
    dispose() { if (!disposed) abandon(); },
  };
}

export async function loadReactor(options) {
  return instantiateReactor(await prepareReactor(options), options);
}
