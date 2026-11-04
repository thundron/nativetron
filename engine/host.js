import { EngineError, ENGINE_INBOUND_LIMIT, createRateWindow, errorText, instantiateReactor, prepareReactor } from "./reactor.js";
import { decodeEngineMessage, ENGINE_MAX_RATE, LANE_ENGINE, LANE_NATIVE, LANE_UI } from "../ipc/engine.generated.mjs";

export { EngineError };
export const ENGINE_STATES = Object.freeze(["starting", "ready", "lost", "failed", "restarting", "disposing", "disposed"]);
export const ENGINE_STARTUP_QUEUE_LIMIT = 32;
export const ENGINE_CONTROL_QUEUE_LIMIT = ENGINE_INBOUND_LIMIT;
export const ENGINE_TIMEOUTS = Object.freeze({ probeMs: 5000, prepareMs: 15000, startMs: 15000, shutdownMs: 1000 });

// Page-side viewport watcher for a transferred canvas. Every listener it installs is removed by dispose().
export function watchViewport(scope, canvas, onSize) {
  let closed = false, observer = null, media = null, frame = null, last = "";
  const measure = (force) => {
    if (closed) return;
    const dpr = scope.devicePixelRatio ?? 1;
    const width = Math.max(1, Math.round((canvas.clientWidth ?? 0) * dpr)), height = Math.max(1, Math.round((canvas.clientHeight ?? 0) * dpr));
    const key = `${width}/${height}/${dpr}`;
    if (!force && key === last) return;
    last = key;
    onSize(width, height, dpr);
  };
  const changedDpr = () => { if (!closed) { measure(false); arm(); } };
  const arm = () => {
    media?.removeEventListener?.("change", changedDpr); media = null;
    if (closed || !scope.matchMedia) return;
    media = scope.matchMedia(`(resolution: ${scope.devicePixelRatio ?? 1}dppx)`);
    media?.addEventListener?.("change", changedDpr, { once: true });
  };
  const changedWindow = () => {
    if (closed || frame !== null) return;
    if (!scope.requestAnimationFrame) { changedDpr(); return; }
    frame = scope.requestAnimationFrame(() => { frame = null; changedDpr(); });
  };
  if (scope.ResizeObserver) { observer = new scope.ResizeObserver(() => measure(false)); observer.observe(canvas); }
  scope.addEventListener?.("resize", changedWindow);
  arm();
  return {
    refresh: () => measure(true),
    get closed() { return closed; },
    dispose() {
      if (closed) return;
      closed = true;
      observer?.disconnect(); observer = null;
      media?.removeEventListener?.("change", changedDpr); media = null;
      scope.removeEventListener?.("resize", changedWindow);
      if (frame !== null) scope.cancelAnimationFrame?.(frame);
      frame = null;
    },
  };
}

// Built-in owned-canvas recovery: an element clone that keeps attributes (id, class, style, size) and takes the
// transferred canvas's place in the document. The transferred element can never render again.
export function replaceCanvasElement(old) {
  const doc = old?.ownerDocument;
  if (!doc?.createElement || typeof old.replaceWith !== "function") return null;
  const fresh = doc.createElement("canvas");
  for (const { name, value } of Array.from(old.attributes ?? [])) fresh.setAttribute(name, value);
  old.replaceWith(fresh);
  return fresh;
}

export async function startEngine(options) {
  const lane = createEngine(options);
  try { await lane.ready; }
  catch (error) { await lane.dispose(); throw error; }
  return lane;
}

export function createEngine(options) {
  const { report = console.log, postNative = () => {}, postUi = () => {} } = options;
  const scope = options.scope ?? globalThis;
  const clock = options.clock ?? {};
  const now = clock.now ?? (() => performance.now());
  const setTimer = clock.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = clock.clearTimeout ?? ((token) => clearTimeout(token));
  const timeouts = { ...ENGINE_TIMEOUTS, ...options.timeouts };
  const assets = { moduleUrl: options.moduleUrl, wasmUrl: options.wasmUrl, prefix: options.prefix };
  const inboundRate = createRateWindow(ENGINE_MAX_RATE, 1000, now);
  const stats = { accepted: 0, rejected: 0, routed: 0, routeRejected: 0, startupDropped: 0, restarts: 0, forcedShutdowns: 0 };
  const startupQueue = [];
  const waiters = new Set();
  let state = "starting", mode = null, reason = "", generation = 0, canvas = options.canvas, transferred = false;
  let worker = null, workerAlive = false, reactor = null, prepared = null, watcher = null, failure = null, gpu = null;
  let inFlight = 0, restarting = null, closing = null, abortError = null, notedAt = new Map();

  const later = (fn) => queueMicrotask(() => { try { fn(); } catch (error) { console.error(error); } });
  const say = (line) => later(() => report(line));
  const note = (kind, line) => { const time = now(); if (time - (notedAt.get(kind) ?? -Infinity) >= 1000) { notedAt.set(kind, time); say(line); } };
  const safe = (fn, ...args) => { try { fn?.(...args); } catch (error) { note("callback", `ENGINE_CALLBACK_ERROR ${errorText(error)}`); } };
  const setState = (next, detail = {}) => {
    if (state === next) return;
    const event = { state: next, previous: state, mode, reason, generation, ...detail };
    state = next;
    if (options.onLifecycle) later(() => options.onLifecycle(event));
  };
  const canvasError = (code, message, cause) => new EngineError(code, message, { cause, canvasTransferred: transferred });

  // Cancellation: dispose() and options.signal reject every pending await and waiter.
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const guard = (promise, cleanup) => Promise.race([promise, aborted]).catch((error) => {
    if (abortError && cleanup) Promise.resolve(promise).then(cleanup, () => {});
    throw error;
  });
  const checkAbort = () => { if (abortError) throw abortError; };
  const abort = (error) => { if (abortError) return; abortError = error; rejectAbort(error); for (const waiter of [...waiters]) if (!waiter.types.includes("stopped")) waiter.reject(error); };
  const abortFor = () => new EngineError(abortError.code, abortError.message, { name: "AbortError", cause: abortError.cause, canvasTransferred: transferred });

  // Worker channel.
  const expect = (types, gen, ms, code, message) => new Promise((resolve, reject) => {
    const waiter = {
      types, gen,
      resolve: (value) => { finish(); resolve(value); },
      reject: (error) => { finish(); reject(error); },
      timer: setTimer(() => waiter.reject(canvasError(code, message)), ms),
    };
    const finish = () => { clearTimer(waiter.timer); waiters.delete(waiter); };
    if (abortError && !types.includes("stopped")) { waiter.reject(abortError); return; }
    waiters.add(waiter);
  });
  const workerFault = (error) => {
    if (waiters.size) { for (const waiter of [...waiters]) if (!waiter.types.includes("stopped")) waiter.reject(error); }
    else if (state === "ready" || state === "lost") engineFailed(error);
  };
  const onWorkerMessage = ({ data }) => {
    if (!data || typeof data.type !== "string") return;
    for (const waiter of waiters) {
      if (waiter.types.includes(data.type) && (waiter.gen === undefined || waiter.gen === data.generation)) { waiter.resolve(data); return; }
    }
    if (data.generation !== generation || state === "disposing" || state === "disposed") return;
    switch (data.type) {
      case "report": safe(report, String(data.message)); break;
      case "message": route(data.bytes); break;
      case "gpu-event": gpuEvent(data.event); break;
      case "credit": if (Number.isInteger(data.count) && data.count > 0) inFlight = Math.max(0, inFlight - data.count); break;
      case "failed": engineFailed(new EngineError(data.code ?? "engine-failed", String(data.message))); break;
    }
  };
  const onWorkerError = (event) => {
    event?.preventDefault?.();
    workerFault(new EngineError("worker-error", `engine worker failed${event?.message ? ": " + event.message : ""}`, { canvasTransferred: transferred }));
  };
  const onWorkerMessageError = () => workerFault(new EngineError("worker-messageerror", "engine worker message could not be deserialized", { canvasTransferred: transferred }));
  const attach = (target) => { target.onmessage = onWorkerMessage; target.onerror = onWorkerError; target.onmessageerror = onWorkerMessageError; };
  const kill = (target) => {
    if (!target) return;
    target.onmessage = null; target.onerror = null; target.onmessageerror = null;
    try { target.terminate(); } catch {}
    if (worker === target) { worker = null; workerAlive = false; }
  };
  // Graceful acknowledged shutdown with a bounded terminate() fallback. Concurrent stops share one acknowledgement.
  const stops = new WeakMap();
  const stopWorker = (target) => {
    if (!target) return Promise.resolve({ graceful: true, reason: "" });
    if (!stops.has(target)) stops.set(target, stopOnce(target));
    return stops.get(target);
  };
  const stopOnce = async (target) => {
    if (worker !== target || !workerAlive) { kill(target); return { graceful: false, reason: "engine worker was not responsive" }; }
    workerAlive = false;
    const ack = expect(["stopped"], undefined, timeouts.shutdownMs, "shutdown-timeout", `engine worker did not acknowledge stop within ${timeouts.shutdownMs} ms`);
    try { target.postMessage({ type: "stop" }); }
    catch (error) { kill(target); stats.forcedShutdowns++; return { graceful: false, reason: errorText(error) }; }
    try {
      const result = await ack;
      return result.ok === false ? { graceful: false, reason: result.message } : { graceful: true, reason: "" };
    } catch (error) { stats.forcedShutdowns++; return { graceful: false, reason: error.message }; }
    finally { kill(target); }
  };

  // Routing. Inbound is validated, rate-limited and bounded here; outbound is shaped by reactor.js and validated here.
  const route = (bytes) => {
    const frame = bytes instanceof Uint8Array ? decodeEngineMessage(bytes) : null;
    if (!frame || frame.source !== LANE_ENGINE || (frame.target !== LANE_NATIVE && frame.target !== LANE_UI)) {
      stats.routeRejected++; note("route", "ENGINE_ROUTE_REJECTED invalid engine source"); return;
    }
    stats.routed++;
    safe(frame.target === LANE_NATIVE ? postNative : postUi, bytes);
  };
  const gpuEvent = (event) => {
    if (event?.type === 1) gpu = event.available ? { available: true, features: event.features ?? [] } : { available: false, reason: event.reason ?? "" };
    if (event?.type === 5 && state === "ready") { setState("lost", { code: "device-lost", message: event.message ?? event.reason ?? "" }); say(`ENGINE_DEVICE_LOST ${event.reason ?? ""} ${event.message ?? ""}`.trim()); }
    safe(options.onEvent, event);
  };
  const engineFailed = (error) => {
    if (state !== "ready" && state !== "lost") return;
    failure = error; inFlight = 0;
    if (mode === "main") { reactor?.dispose(); reactor = null; }
    setState("failed", { code: error.code, message: error.message });
    say(`ENGINE_FAILED ${error.message}`);
  };
  const transmit = (bytes) => {
    if (mode === "worker") {
      if (!workerAlive) throw new EngineError("failed", "engine worker unavailable");
      const copy = bytes.slice();
      inFlight++;
      worker.postMessage({ type: "message", generation, bytes: copy }, [copy.buffer]);
    } else reactor.receive(bytes);
  };
  const flushStartup = () => {
    const queued = startupQueue.splice(0);
    for (const bytes of queued) {
      try { transmit(bytes); } catch (error) { stats.startupDropped++; note("startup", `ENGINE_QUEUE_DROPPED ${errorText(error)}`); }
    }
  };
  const dropStartup = (why) => {
    if (!startupQueue.length) return;
    stats.startupDropped += startupQueue.length;
    say(`ENGINE_QUEUE_DROPPED ${startupQueue.length} queued control messages (${why})`);
    startupQueue.length = 0;
  };
  const resized = (width, height, dpr) => {
    if (mode !== "worker" || !workerAlive || (state !== "ready" && state !== "lost")) return;
    worker.postMessage({ type: "resize", generation, width, height, dpr });
  };
  const becomeReady = () => {
    inFlight = 0; failure = null;
    if (mode === "worker") { watcher ??= watchViewport(scope, canvas, resized); }
    setState("ready");
    watcher?.refresh();
    flushStartup();
  };

  // Startup.
  const recoverCanvas = () => {
    const strategy = options.canvasRecovery ?? "none";
    if (strategy === "none" || !transferred) return null;
    let fresh = null;
    try { fresh = typeof strategy === "function" ? strategy(canvas) : strategy === "replace" ? replaceCanvasElement(canvas) : null; }
    catch (error) { say(`ENGINE_CANVAS_RECOVERY_FAILED ${errorText(error)}`); return null; }
    if (!fresh || fresh === canvas) return null;
    watcher?.dispose(); watcher = null;
    canvas = fresh; transferred = false;
    say("ENGINE_CANVAS_REPLACED");
    return fresh;
  };
  const probeWorker = async () => {
    if (!scope.Worker || typeof canvas?.transferControlToOffscreen !== "function") return { available: false, reason: "Worker or OffscreenCanvas unavailable" };
    let target;
    try { target = new scope.Worker(new URL("./worker.js", import.meta.url), { type: "module" }); }
    catch (error) { return { available: false, reason: `module Worker could not start: ${errorText(error)}` }; }
    worker = target; workerAlive = true; attach(target);
    try {
      const probed = expect(["probe"], undefined, timeouts.probeMs, "probe-timeout", "worker probe timed out");
      target.postMessage({ type: "probe" });
      const result = await guard(probed);
      if (!result.available) throw new EngineError("probe-failed", result.reason || "worker probe failed");
      const ready = expect(["prepared"], undefined, timeouts.prepareMs, "prepare-timeout", "worker engine preparation timed out");
      target.postMessage({ type: "prepare", options: assets });
      const done = await guard(ready);
      if (!done.ok) throw new EngineError(done.code ?? "prepare-failed", `worker preparation failed: ${done.reason}`);
      return { available: true };
    } catch (error) {
      if (abortError) throw error;
      kill(target);
      return { available: false, reason: error.code === "worker-error" ? "module Worker could not start" : error.message };
    }
  };
  const startMain = async () => {
    prepared ??= await guard(prepareReactor({ ...assets, fetch: options.fetch }));
    const gen = ++generation;
    const current = () => gen === generation && !abortError;
    const created = await guard(instantiateReactor(prepared, {
      canvas, scope, now, pixelRatio: scope.devicePixelRatio ?? 1,
      setTimer: clock.setTimeout, clearTimer: clock.clearTimeout,
      cancelled: () => !current(),
      report: (text) => { if (current()) safe(report, text); },
      post: (bytes) => { if (current()) route(bytes); },
      onEvent: (event) => { if (current()) gpuEvent(event); },
      onFailure: (error) => { if (current()) engineFailed(error); },
    }), (orphan) => orphan.dispose());
    if (!current()) { created.dispose(); checkAbort(); throw new EngineError("superseded", "engine generation superseded"); }
    reactor = created; mode = "main";
  };
  const startWorker = async () => {
    let offscreen;
    try { offscreen = canvas.transferControlToOffscreen(); }
    catch (error) { kill(worker); return `canvas transfer failed: ${errorText(error)}`; }
    transferred = true;
    const gen = ++generation;
    const started = expect(["ready", "error"], gen, timeouts.startMs, "start-timeout", "engine worker startup timed out after canvas transfer");
    worker.postMessage({ type: "start", generation: gen, canvas: offscreen, options: { pixelRatio: scope.devicePixelRatio ?? 1 } }, [offscreen]);
    const result = await guard(started);
    if (result.type === "error") throw new EngineError(result.code ?? "start-failed", String(result.message), { canvasTransferred: true });
    mode = "worker";
    return null;
  };
  // Full sequence: probe (no canvas side effects) → transfer → start; or main thread on an untransferred canvas.
  const boot = async () => {
    checkAbort();
    if (!canvas) throw new EngineError("invalid-options", "engine canvas is required");
    let capability;
    try { capability = options.forceMain ? { available: false, reason: "main thread requested" } : await probeWorker(); }
    catch (error) { if (abortError) throw error; capability = { available: false, reason: errorText(error) }; }
    if (capability.available) {
      let fallback;
      try { fallback = await startWorker(); }
      catch (error) {
        if (abortError) throw error;
        say(`ENGINE_ERROR ${error.message}`);
        error.reported = true;
        const workerGone = error.code === "worker-error" || error.code === "start-timeout" || error.code === "worker-messageerror";
        const stopped = await stopWorker(worker);
        if (!stopped.graceful && !workerGone) say(`ENGINE_SHUTDOWN_FORCED ${stopped.reason}`);
        checkAbort();
        if (!recoverCanvas()) throw new EngineError("start-failed-after-transfer", `engine worker failed after canvas transfer: ${error.message}`, { cause: error, canvasTransferred: true, phase: "start", reported: true });
        reason = `worker failed after canvas transfer (${error.message}); recovered on a replacement canvas`;
        await startMain();
        return;
      }
      if (fallback === null) { reason = capability.reason ?? ""; return; }
      capability = { available: false, reason: fallback };
    }
    reason = capability.reason ?? "";
    await startMain();
  };

  const ready = (async () => {
    await null;
    try {
      if (options.signal?.aborted) abort(new EngineError("aborted", "engine start aborted", { name: "AbortError", cause: options.signal.reason }));
      await boot();
      checkAbort();
      say(`ENGINE_MODE ${mode}${reason ? " (" + reason + ")" : ""}`);
      becomeReady();
    } catch (error) {
      if (abortError) {
        if (state === "starting") lane.dispose();
        throw abortFor();
      }
      failure = error instanceof EngineError ? error : new EngineError("start-failed", errorText(error), { cause: error });
      if (failure.canvasTransferred === undefined) failure.canvasTransferred = transferred;
      if (mode !== "main" || !reactor) mode = null;
      dropStartup("startup failed");
      if (!failure.reported) say(`ENGINE_ERROR ${failure.message}`);
      setState("failed", { code: failure.code, message: failure.message });
      throw failure;
    }
    return lane;
  })();
  ready.catch(() => {});

  const restartBody = async (why) => {
    setState("restarting", { why });
    stats.restarts++;
    failure = null; inFlight = 0;
    try {
      if (mode === "worker" && workerAlive) {
        const gen = ++generation;
        const started = expect(["ready", "error"], gen, timeouts.startMs, "restart-timeout", "engine worker restart timed out");
        worker.postMessage({ type: "restart", generation: gen, options: { pixelRatio: scope.devicePixelRatio ?? 1 } });
        let result;
        try { result = await guard(started); }
        catch (error) {
          if (abortError) throw error;
          // Unresponsive worker: its canvas is unreachable. Recover onto an owned canvas when allowed.
          say(`ENGINE_ERROR ${error.message}`);
          await stopWorker(worker);
          checkAbort();
          if (!recoverCanvas()) throw error;
          mode = null; reason = "";
          await boot();
          say(`ENGINE_MODE ${mode}${reason ? " (" + reason + ")" : ""}`);
          result = { type: "ready" };
        }
        if (result.type === "error") throw new EngineError(result.code ?? "restart-failed", String(result.message), { canvasTransferred: true });
      } else if (mode === "main") {
        reactor?.dispose(); reactor = null;
        await startMain();
      } else if (!transferred || recoverCanvas()) {
        if (worker) kill(worker);
        mode = null; reason = "";
        await boot();
        say(`ENGINE_MODE ${mode}${reason ? " (" + reason + ")" : ""}`);
      } else {
        throw new EngineError("canvas-lost", "engine canvas was transferred to a worker that is no longer running; restart requires canvasRecovery or a new canvas", { canvasTransferred: true });
      }
      checkAbort();
      becomeReady();
      say(`ENGINE_RESTARTED ${mode} generation ${generation}`);
      return { ok: true, mode, reason, generation, canvas };
    } catch (error) {
      if (abortError) return { ok: false, code: "aborted", message: "engine lane disposed during restart", mode, generation };
      failure = error instanceof EngineError ? error : new EngineError("restart-failed", errorText(error), { cause: error });
      if (mode === "main") { reactor?.dispose(); reactor = null; }
      dropStartup("restart failed");
      setState("failed", { code: failure.code, message: failure.message });
      say(`ENGINE_RESTART_FAILED ${failure.message}`);
      return { ok: false, code: failure.code ?? "restart-failed", message: failure.message, mode, generation, canvasTransferred: transferred && !workerAlive, workerAlive };
    }
  };

  const fail = (code, message) => ({ ok: false, code, message, error: new EngineError(code, message) });
  const lane = {
    get mode() { return mode; },
    get reason() { return reason; },
    get state() { return state; },
    get generation() { return generation; },
    get canvas() { return canvas; },
    get reactor() { return mode === "main" ? reactor ?? undefined : undefined; },
    get gpu() { return gpu; },
    get failure() { return failure; },
    get stats() { return { ...stats, inFlight, startupQueued: startupQueue.length, workerAlive }; },
    ready,
    // Never throws and never calls consumer callbacks synchronously; safe from inside another reactor's import.
    trySend(bytes, source = LANE_UI) {
      const result = (() => {
        if (state === "disposing" || state === "disposed") return fail("disposed", "engine lane disposed");
        const frame = bytes instanceof Uint8Array ? decodeEngineMessage(bytes) : null;
        if (!frame || frame.source !== source || frame.target !== LANE_ENGINE || (source !== LANE_UI && source !== LANE_NATIVE)) return fail("invalid-route", "invalid engine message route");
        if (state === "failed") return fail("failed", `engine lane failed; restart required (${failure?.message ?? "unknown failure"})`);
        const queued = state === "starting" || state === "restarting";
        if (queued ? startupQueue.length >= ENGINE_STARTUP_QUEUE_LIMIT : mode === "worker" ? inFlight >= ENGINE_CONTROL_QUEUE_LIMIT : (reactor?.pending ?? 0) >= ENGINE_INBOUND_LIMIT) {
          return fail("queue-full", queued ? "engine startup queue full" : "engine control queue full");
        }
        if (inboundRate.take()) return fail("rate-limited", "engine control rate exceeded");
        if (queued) { startupQueue.push(bytes.slice()); return { ok: true, queued: true }; }
        try { transmit(bytes); } catch (error) { return { ok: false, code: error.code ?? "failed", message: errorText(error), error }; }
        return { ok: true, queued: false };
      })();
      if (result.ok) stats.accepted++; else stats.rejected++;
      return result;
    },
    send(bytes, source = LANE_UI) {
      const result = lane.trySend(bytes, source);
      if (!result.ok) throw result.error;
    },
    restart(options = {}) {
      if (restarting) return restarting;
      if (state === "disposing" || state === "disposed") return Promise.resolve({ ok: false, code: "disposed", message: "engine lane disposed", mode, generation });
      if (state === "starting") return Promise.resolve({ ok: false, code: "starting", message: "engine lane is still starting; await ready first", mode, generation });
      restarting = restartBody(options.reason ?? "requested").finally(() => { restarting = null; });
      return restarting;
    },
    dispose() {
      if (closing) return closing;
      setState("disposing");
      abort(new EngineError("aborted", "engine lane disposed", { name: "AbortError" }));
      options.signal?.removeEventListener?.("abort", onAbort);
      startupQueue.length = 0;
      watcher?.dispose(); watcher = null;
      closing = (async () => {
        const result = worker ? await stopWorker(worker) : { graceful: true, reason: "" };
        reactor?.dispose(); reactor = null;
        if (!result.graceful) say(`ENGINE_SHUTDOWN_FORCED ${result.reason}`);
        setState("disposed", result);
        return { ...result, mode };
      })();
      return closing;
    },
  };
  const onAbort = () => { if (!closing) lane.dispose(); };
  options.signal?.addEventListener?.("abort", onAbort, { once: true });
  return lane;
}
