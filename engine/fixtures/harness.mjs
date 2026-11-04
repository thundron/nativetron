// Test-only page/worker doubles for engine lifecycle tests. Nothing here is staged into application bundles.
import { encodeEngineMessage, ENGINE_COMMAND, LANE_ENGINE, LANE_NATIVE, LANE_UI } from "../../ipc/engine.generated.mjs";

export const glue = (mode = "ok") => new URL(`./fake-glue.mjs?mode=${mode}`, import.meta.url).href;
export const fixtureLog = () => (globalThis.__engineFixture ??= { instances: 0, calls: [], hooks: {} });
export const tick = () => new Promise((done) => setImmediate(done));
export const settle = async (count = 8) => { for (let i = 0; i < count; i++) await tick(); };
export const ui = (topic, payload = []) => encodeEngineMessage(ENGINE_COMMAND, LANE_UI, LANE_ENGINE, 0, topic, new Uint8Array(payload));
export const native = (topic, payload = []) => encodeEngineMessage(ENGINE_COMMAND, LANE_NATIVE, LANE_ENGINE, 0, topic, new Uint8Array(payload));

// Minimal valid module exporting memory and `${prefix}{start,frame,event,message}` as empty functions.
export function fixtureWasm(prefix = "fx_", names = ["start", "frame", "event", "message"]) {
  const text = new TextEncoder();
  const vec = (items) => [items.length, ...items.flat()];
  const section = (id, body) => [id, body.length, ...body];
  const exports = [[...vec([...text.encode("memory")]), 2, 0], ...names.map((name, index) => [...vec([...text.encode(prefix + name)]), 0, index])];
  const bytes = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, vec(names.map(() => [0]))),
    ...section(5, [1, 0, 1]),
    ...section(7, vec(exports)),
    ...section(10, vec(names.map(() => [2, 0, 0x0b]))),
  ];
  return new Uint8Array(bytes);
}
export const wasmUrl = (bytes = fixtureWasm()) => `data:application/wasm;base64,${Buffer.from(bytes).toString("base64")}`;

// Manually driven clock used for rate windows and timeouts.
export function manualClock() {
  let time = 0, next = 1;
  const timers = new Map();
  const clock = {
    now: () => time,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: time + Math.max(0, ms), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    get pending() { return timers.size; },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        let id = null, due = null;
        for (const [key, timer] of timers) if (timer.at <= end && (due === null || timer.at < due.at)) { id = key; due = timer; }
        if (due === null) break;
        timers.delete(id); time = due.at; due.fn();
      }
      time = end;
    },
  };
  return clock;
}

export class FakeOffscreenCanvas {
  constructor(width = 1, height = 1) { this.width = width; this.height = height; this.contexts = 0; }
  getContext() { this.contexts++; return { configure() {}, getCurrentTexture() { return {}; }, unconfigure() {} }; }
}

// Counts every listener, observer and frame callback the page scope hands out.
export function pageScope(extra = {}) {
  const listeners = new Map(), media = new Set(), observers = new Set(), frames = new Map();
  let frameId = 0;
  const scope = {
    devicePixelRatio: 1,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type) { for (const fn of [...(listeners.get(type) ?? [])]) fn({ type }); },
    matchMedia(query) {
      const list = { query, handlers: new Set(),
        addEventListener(type, fn) { list.handlers.add(fn); media.add(list); },
        removeEventListener(type, fn) { list.handlers.delete(fn); if (!list.handlers.size) media.delete(list); },
        fire() { const handlers = [...list.handlers]; list.handlers.clear(); media.delete(list); for (const fn of handlers) fn({}); } };
      return list;
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.add(this); }
      observe(target) { this.targets.add(target); }
      disconnect() { this.targets.clear(); observers.delete(this); }
    },
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    runFrames() { const pending = [...frames]; frames.clear(); for (const [, fn] of pending) fn(0); },
    fireMedia() { for (const list of [...media]) list.fire(); },
    resizeObservers() { for (const observer of [...observers]) observer.callback([]); },
    leaks() {
      let windowListeners = 0;
      for (const set of listeners.values()) windowListeners += set.size;
      return { windowListeners, media: media.size, observers: observers.size, frames: frames.size };
    },
    ...extra,
  };
  return scope;
}

export function fakeDocument() {
  const doc = {
    replaced: [],
    createElement(tag) { if (tag !== "canvas") throw new Error("unexpected element"); return fakeCanvas(doc); },
  };
  return doc;
}
export function fakeCanvas(doc = fakeDocument()) {
  const attributes = new Map([["id", "surface"], ["class", "view"]]);
  const canvas = {
    ownerDocument: doc, clientWidth: 320, clientHeight: 200, width: 300, height: 150, transferred: false, contexts: 0,
    get attributes() { return [...attributes].map(([name, value]) => ({ name, value })); },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    getContext() { if (canvas.transferred) throw new Error("InvalidStateError: canvas transferred"); canvas.contexts++; return { configure() {}, unconfigure() {}, getCurrentTexture() { return {}; } }; },
    transferControlToOffscreen() {
      if (canvas.transferred) throw new Error("InvalidStateError: already transferred");
      canvas.transferred = true;
      return new FakeOffscreenCanvas(canvas.width, canvas.height);
    },
    replaceWith(fresh) { doc.replaced.push({ old: canvas, fresh }); canvas.detached = true; },
  };
  return canvas;
}

// Worker double that runs the real engine/worker.js against a fake worker global scope.
let importChain = Promise.resolve(), workerSeq = 0;
export function bridgedWorkerClass(registry = []) {
  return class BridgedWorker {
    constructor(url, options) {
      if (options?.type !== "module") throw new Error("expected module worker");
      registry.push(this);
      this.terminated = false; this.closed = false; this.received = [];
      this.onmessage = null; this.onerror = null; this.onmessageerror = null;
      const worker = this;
      const self = this.self = {
        navigator: { gpu: { requestAdapter: async () => ({ features: new Set(), requestDevice: async () => ({ destroy() {} }) }), getPreferredCanvasFormat: () => "bgra8unorm" } },
        OffscreenCanvas: FakeOffscreenCanvas, WebAssembly,
        requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0), cancelAnimationFrame: (id) => clearTimeout(id),
        addEventListener() {}, removeEventListener() {},
        postMessage(data) { if (worker.terminated || worker.closed) return; setImmediate(() => { if (!worker.terminated) worker.onmessage?.({ data }); }); },
        close() { worker.closed = true; },
        onmessage: null,
      };
      const href = new URL(`../worker.js?bridged=${++workerSeq}`, import.meta.url).href;
      this.loaded = importChain = importChain.then(async () => { globalThis.self = self; try { await import(href); } finally { delete globalThis.self; } });
    }
    postMessage(data) {
      if (this.terminated) return;
      this.received.push(data.type);
      this.loaded.then(() => setImmediate(() => { if (!this.terminated && !this.closed) this.self.onmessage?.({ data }); }));
    }
    terminate() { this.terminated = true; }
  };
}

// Worker double whose replies are scripted per request type: a function returns replies, "hang" never answers.
export function scriptedWorkerClass(script, registry = []) {
  return class ScriptedWorker {
    constructor() {
      registry.push(this);
      this.terminated = false; this.received = []; this.onmessage = null; this.onerror = null; this.onmessageerror = null;
    }
    emit(data) { if (!this.terminated) setImmediate(() => { if (!this.terminated) this.onmessage?.({ data }); }); }
    fault(message = "boom") { this.onerror?.({ message, preventDefault() {} }); }
    postMessage(data) {
      if (this.terminated) return;
      this.received.push(data);
      const reply = script[data.type] ?? ScriptedWorker.defaults[data.type];
      if (reply === "hang" || !reply) return;
      for (const message of [].concat(reply(data, this) ?? [])) this.emit(message);
    }
    terminate() { this.terminated = true; }
    static defaults = {
      probe: () => ({ type: "probe", available: true }),
      prepare: () => ({ type: "prepared", ok: true }),
      start: (data) => ({ type: "ready", generation: data.generation }),
      restart: (data) => ({ type: "ready", generation: data.generation }),
      stop: () => ({ type: "stopped", ok: true }),
      message: (data) => ({ type: "credit", generation: data.generation, count: 1 }),
    };
  };
}

export function baseOptions(extra = {}) {
  const reports = [], toUi = [], toNative = [], lifecycle = [], events = [];
  const options = {
    canvas: fakeCanvas(), moduleUrl: glue(), wasmUrl: wasmUrl(), prefix: "fx_",
    report: (line) => reports.push(line), postUi: (bytes) => toUi.push(bytes), postNative: (bytes) => toNative.push(bytes),
    onLifecycle: (event) => lifecycle.push(event), onEvent: (event) => events.push(event),
    scope: pageScope(),
    ...extra,
  };
  return { options, reports, toUi, toNative, lifecycle, events };
}

// Minimal WebGPU double for the GPU host: devices can be lost on demand and record destruction.
export function fakeGpu() {
  const devices = [];
  return {
    devices,
    getPreferredCanvasFormat: () => "bgra8unorm",
    requestAdapter: async () => ({
      features: new Set(),
      requestDevice: async () => {
        let lose;
        const device = { features: new Set(), limits: { maxBufferSize: 256 }, destroyed: false, queue: {}, lost: new Promise((done) => { lose = done; }),
          lose: (reason = "unknown") => lose({ reason, message: "fake device loss" }), destroy() { device.destroyed = true; }, addEventListener() {} };
        devices.push(device);
        return device;
      },
    }),
  };
}
