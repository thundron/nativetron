// Binary wire between engine/native-gpu.js (in the engine Worker or page) and a native GPU executor host.
// Upstream: `fetch` POST bodies of 32-byte-header frames; command/upload chunks travel as their own bodies with
// the header written into bytes the transport core reserved in front of each owned chunk (no second copy).
// Downstream: one outstanding long-poll GET per engine generation; the host holds it while it has nothing to
// say and answers with every queued frame as soon as one exists, then the Worker re-issues it. Nothing runs
// while idle (no timers, no busy loop). A long-lived streamed response is NOT used: WebKit holds back
// WKURLSchemeTask writes that follow another write within a few milliseconds until a later write arrives. No base64 and no 64 KiB control
// bridge are involved. The capability token (`session`) is issued once per page load by the native host.
// The frame layout is mirrored in hosts/macos/NativeGPUWire.swift (checked by engine/native-gpu-wire.test.mjs).

export const WIRE_MAGIC = 0x3157474e; // "NGW1"
export const WIRE_HEADER_BYTES = 32;
export const WIRE_CHUNK_RESERVE = 256; // pending control frames + the chunk header fit in front of every chunk
export const WIRE_MAX_CONTROL_PAYLOAD = 4096;
export const WIRE_MAX_DOWN_FRAME = WIRE_HEADER_BYTES + 8 + 4 * 1048576; // readback chunk bound (JSON is smaller)
export const WIRE_MAX_PENDING_CONTROL = 65536;
export const WIRE = Object.freeze({
  OPEN: 1, SUBMIT: 2, CHUNK: 3, FRAME_MODE: 4, TICK_REQUEST: 5, TICK_CANCEL: 6, CLOSE: 7,
  FRAME_END: 8, // a = frame, sequence = its last submission: fence the GPU work of that frame
  ACK: 16, EVENT: 17, READBACK: 18, FRAME_REQUEST: 19, FAILED: 20, TICK: 21,
  FRAME_DONE: 22, // a = frame, b = status (0 done, 1 lost, 2 cancelled): the GPU finished the frame's work
});
export const WIRE_FLAG_LAST = 1; // CHUNK: final chunk of the submission
export const WIRE_FLAG_THROUGHPUT = 1; // OPEN: initial frame mode
const MODES = { display: 0, throughput: 1 };
const align4 = (n) => (n + 3) & ~3;
const text = (error) => error instanceof Error ? error.message : String(error);

export function writeWireHeader(bytes, at, kind, flags, engine, sequence, a, b, c, payloadBytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, WIRE_HEADER_BYTES);
  view.setUint32(0, WIRE_MAGIC, true); view.setUint16(4, kind, true); view.setUint16(6, flags, true);
  view.setUint32(8, engine >>> 0, true); view.setUint32(12, sequence >>> 0, true);
  view.setUint32(16, a >>> 0, true); view.setUint32(20, b >>> 0, true); view.setUint32(24, c >>> 0, true);
  view.setUint32(28, payloadBytes >>> 0, true);
}

export function readWireHeader(bytes, at = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, WIRE_HEADER_BYTES);
  if (view.getUint32(0, true) !== WIRE_MAGIC) return null;
  return {
    kind: view.getUint16(4, true), flags: view.getUint16(6, true), engine: view.getUint32(8, true), sequence: view.getUint32(12, true),
    a: view.getUint32(16, true), b: view.getUint32(20, true), c: view.getUint32(24, true), payloadBytes: view.getUint32(28, true),
  };
}

// Small frame (control, no bulk payload) as its own padded allocation.
export function encodeWireFrame(kind, { flags = 0, engine = 0, sequence = 0, a = 0, b = 0, c = 0, payload } = {}) {
  const size = payload?.byteLength ?? 0;
  const frame = new Uint8Array(align4(WIRE_HEADER_BYTES + size));
  writeWireHeader(frame, 0, kind, flags, engine, sequence, a, b, c, size);
  if (size) frame.set(payload, WIRE_HEADER_BYTES);
  return frame;
}

// Incremental parser: stream chunks may split or merge frames arbitrarily. Bounded by maxFrameBytes.
export function createWireParser({ onFrame, maxFrameBytes = WIRE_MAX_DOWN_FRAME }) {
  let buffer = new Uint8Array(0), stats = { frames: 0, bytes: 0, copiedBytes: 0 };
  return {
    push(chunk) {
      stats.bytes += chunk.byteLength;
      let data = chunk, at = 0;
      if (buffer.byteLength) {
        data = new Uint8Array(buffer.byteLength + chunk.byteLength);
        data.set(buffer); data.set(chunk, buffer.byteLength); stats.copiedBytes += data.byteLength;
        buffer = new Uint8Array(0);
      }
      while (data.byteLength - at >= WIRE_HEADER_BYTES) {
        const header = readWireHeader(data, at);
        if (!header) throw new Error("native GPU wire: bad frame magic");
        const total = align4(WIRE_HEADER_BYTES + header.payloadBytes);
        if (WIRE_HEADER_BYTES + header.payloadBytes > maxFrameBytes) throw new Error(`native GPU wire: frame of ${header.payloadBytes} bytes exceeds bound`);
        if (data.byteLength - at < WIRE_HEADER_BYTES + header.payloadBytes) break;
        stats.frames++;
        onFrame(header, data.subarray(at + WIRE_HEADER_BYTES, at + WIRE_HEADER_BYTES + header.payloadBytes));
        at = Math.min(data.byteLength, at + total);
      }
      if (at < data.byteLength) { buffer = data.slice(at); stats.copiedBytes += buffer.byteLength; }
    },
    get pendingBytes() { return buffer.byteLength; },
    stats,
  };
}

// One wire per engine generation. `connect()` returns the `transport` for createNativeGpuHost plus a
// `createScheduler` that turns frame requests into native display-link (or headless) ticks.
export function createNativeGpuWire(options) {
  const { endpoint, session, engine } = options ?? {};
  if (typeof endpoint !== "string" || !endpoint.endsWith("/")) throw new Error("native GPU wire requires an endpoint ending in '/'");
  if (typeof session !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(session)) throw new Error("native GPU wire requires a session capability");
  if (!Number.isSafeInteger(engine) || engine < 1 || engine > 0xffffffff) throw new Error("native GPU wire requires a positive engine generation");
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => performance.now());
  const maxInflight = options.maxInflight ?? 3;
  const headers = { "X-NT-GPU-Session": session, "Content-Type": "application/octet-stream" };
  let receive = () => {}, resume = () => {}, failed = (error) => { throw error; };
  let closed = false, inflight = 0, bodySequence = 0, flushQueued = false, stream = null;
  let nextToken = 1;
  const pending = []; let pendingBytes = 0;
  const schedulers = new Set();
  const submitted = new Map(); // sequence -> time its SUBMIT was queued (ack latency)
  const tickRequested = new Map(); // token -> time requested
  const stats = {
    bodies: 0, bodyBytes: 0, zeroCopyChunks: 0, copiedChunks: 0, transportCopiedBytes: 0, controlFrames: 0,
    peakInflight: 0, postMs: 0, postMaxMs: 0, polls: 0, pollBytes: 0, pollMaxBytes: 0, framesIn: 0,
    acks: 0, ackMs: 0, ackMaxMs: 0, readbackBytes: 0, readbackCopiedBytes: 0, events: 0, ticks: 0, tickMs: 0, tickMaxMs: 0, staleFrames: 0, framesDone: 0,
  };
  const fail = (message, cause) => {
    if (closed) return;
    const error = new Error(`native GPU wire: ${message}`, cause === undefined ? undefined : { cause });
    try { failed(error); } catch {}
  };
  const url = (path) => `${endpoint}${path}?engine=${engine}`;

  const post = (body) => {
    const seq = ++bodySequence, started = now();
    inflight++; stats.peakInflight = Math.max(stats.peakInflight, inflight);
    stats.bodies++; stats.bodyBytes += body.byteLength;
    fetcher(`${url("post")}&b=${seq}`, { method: "POST", body, headers, cache: "no-store" }).then(async (response) => {
      if (closed) return;
      if (!response.ok) { fail(`host refused body ${seq}: HTTP ${response.status} ${await response.text().catch(() => "")}`); return; }
      const ms = now() - started; stats.postMs += ms; stats.postMaxMs = Math.max(stats.postMaxMs, ms);
      inflight--;
      flushControl();
      resume();
    }, (error) => fail(`body ${seq} failed: ${text(error)}`, error));
  };
  const queueControl = (frame) => {
    if (pendingBytes + frame.byteLength > WIRE_MAX_PENDING_CONTROL) { fail("control backlog exhausted"); return false; }
    pending.push(frame); pendingBytes += frame.byteLength; stats.controlFrames++;
    if (!flushQueued) { flushQueued = true; queueMicrotask(() => { flushQueued = false; flushControl(); }); }
    return true;
  };
  function flushControl() {
    if (closed || !pending.length || inflight >= maxInflight) return;
    const body = new Uint8Array(pendingBytes);
    let at = 0;
    for (const frame of pending) { body.set(frame, at); at += frame.byteLength; }
    stats.transportCopiedBytes += pendingBytes;
    pending.length = 0; pendingBytes = 0;
    post(body);
  }

  const send = (message) => {
    if (closed) throw new Error("native GPU wire closed");
    switch (message.kind) {
      case "open": {
        const payload = new Uint8Array(4); new DataView(payload.buffer).setUint32(0, message.limits.chunkBytes, true);
        return queueControl(encodeWireFrame(WIRE.OPEN, { engine, flags: message.frameMode === "throughput" ? WIRE_FLAG_THROUGHPUT : 0,
          a: message.limits.commandBytes, b: message.limits.uploadBytes, c: message.limits.readbackBytes, payload }));
      }
      case "submit": {
        const payload = new Uint8Array(4); new DataView(payload.buffer).setUint32(0, message.chunks, true);
        submitted.set(message.sequence, now());
        return queueControl(encodeWireFrame(WIRE.SUBMIT, { engine, sequence: message.sequence, a: message.commandBytes, b: message.uploadBytes, c: message.readbackBytes, payload }));
      }
      case "frame-mode": return queueControl(encodeWireFrame(WIRE.FRAME_MODE, { engine, a: MODES[message.mode] ?? 0 }));
      case "frame-end": return queueControl(encodeWireFrame(WIRE.FRAME_END, { engine, sequence: message.through, a: message.frame }));
      case "chunk": {
        if (inflight >= maxInflight) return false;
        const { bytes } = message;
        const flags = message.last ? WIRE_FLAG_LAST : 0, section = message.section === "uploads" ? 1 : 0;
        const prefix = pendingBytes + WIRE_HEADER_BYTES;
        if (bytes.byteOffset >= prefix) {
          // Zero-copy: pending control frames and this header go into the reserved space in front of the chunk.
          const body = new Uint8Array(bytes.buffer, bytes.byteOffset - prefix, prefix + bytes.byteLength);
          let at = 0;
          for (const frame of pending) { body.set(frame, at); at += frame.byteLength; }
          pending.length = 0; pendingBytes = 0;
          writeWireHeader(body, at, WIRE.CHUNK, flags, engine, message.sequence, message.index, message.offset, section, bytes.byteLength);
          stats.zeroCopyChunks++;
          post(body);
        } else {
          flushControl();
          if (inflight >= maxInflight) return false;
          const body = new Uint8Array(WIRE_HEADER_BYTES + bytes.byteLength);
          writeWireHeader(body, 0, WIRE.CHUNK, flags, engine, message.sequence, message.index, message.offset, section, bytes.byteLength);
          body.set(bytes, WIRE_HEADER_BYTES);
          stats.copiedChunks++; stats.transportCopiedBytes += bytes.byteLength;
          post(body);
        }
        return true;
      }
      default: throw new Error(`native GPU wire cannot send ${String(message.kind)}`);
    }
  };

  const decoder = new TextDecoder();
  const onFrame = (header, payload) => {
    stats.framesIn++;
    if (header.engine !== engine) { stats.staleFrames++; return; }
    switch (header.kind) {
      case WIRE.ACK: {
        const at = now();
        for (const [sequence, time] of submitted) {
          if (sequence > header.sequence) break;
          const ms = at - time; stats.acks++; stats.ackMs += ms; stats.ackMaxMs = Math.max(stats.ackMaxMs, ms);
          submitted.delete(sequence);
        }
        receive({ type: "ack", engine, sequence: header.sequence });
        break;
      }
      case WIRE.EVENT: {
        let event;
        try { event = JSON.parse(decoder.decode(payload)); } catch (error) { fail(`malformed event JSON: ${text(error)}`); return; }
        stats.events++;
        receive({ type: "event", engine, device: header.a, event });
        break;
      }
      case WIRE.READBACK: {
        if (payload.byteLength < 8) { fail("short readback frame"); return; }
        const view = new DataView(payload.buffer, payload.byteOffset, 8);
        const bytes = payload.slice(8); // owned: the stream chunk is shared by several frames
        stats.readbackBytes += bytes.byteLength; stats.readbackCopiedBytes += bytes.byteLength;
        receive({ type: "readback", engine, device: header.a, requestId: header.b, offset: header.c, length: view.getUint32(0, true), at: view.getUint32(4, true), bytes });
        break;
      }
      case WIRE.FRAME_REQUEST: receive({ type: "frame-request", engine, device: header.a }); break;
      case WIRE.FRAME_DONE: stats.framesDone++; receive({ type: "frame-done", engine, frame: header.a, status: header.b }); break;
      case WIRE.FAILED: receive({ type: "failed", engine, message: decoder.decode(payload) }); break;
      case WIRE.TICK: {
        const requested = tickRequested.get(header.a);
        tickRequested.delete(header.a);
        if (requested !== undefined) { const ms = now() - requested; stats.ticks++; stats.tickMs += ms; stats.tickMaxMs = Math.max(stats.tickMaxMs, ms); }
        for (const scheduler of schedulers) if (scheduler.fire(header.a)) break;
        break;
      }
      default: fail(`unknown downstream frame ${header.kind}`);
    }
  };

  const openStream = () => {
    if (closed) return;
    const controller = new AbortController();
    stream = controller; stats.polls++;
    fetcher(url("poll"), { headers: { "X-NT-GPU-Session": session }, signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (closed || stream !== controller) return;
      if (!response.ok) { fail(`poll refused: HTTP ${response.status} ${await response.text().catch(() => "")}`); return; }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (closed || stream !== controller) return;
      // The host answers a poll only with frames; an empty answer means it dropped this generation.
      if (bytes.byteLength === 0) { fail("poll closed by host"); return; }
      stats.pollBytes += bytes.byteLength; stats.pollMaxBytes = Math.max(stats.pollMaxBytes, bytes.byteLength);
      const parser = createWireParser({ onFrame });
      try { parser.push(bytes); } catch (error) { fail(text(error), error); return; }
      if (parser.pendingBytes) { fail("poll answer ended inside a frame"); return; }
      openStream();
    }).catch((error) => { if (!closed && stream === controller) fail(`poll failed: ${text(error)}`, error); });
  };

  const wire = {
    engine, stats,
    get inflight() { return inflight; },
    // Binds the wire to a host (host.receive / host.resume / failure sink) and starts the downstream long-poll.
    connect(hooks) {
      receive = hooks.receive; resume = hooks.resume; failed = hooks.fail;
      openStream();
      return wire.transport;
    },
    transport: {
      send,
      close({ reason } = {}) {
        if (closed) return;
        const payload = new TextEncoder().encode(String(reason ?? "closed").slice(0, 256));
        const body = encodeWireFrame(WIRE.CLOSE, { engine, payload });
        closed = true;
        pending.length = 0; pendingBytes = 0; schedulers.clear();
        try { stream?.abort(); } catch {}
        stream = null;
        // Best effort: the host also drops the generation when its stream is cancelled or the page navigates.
        fetcher(`${url("post")}&b=close`, { method: "POST", body, headers, cache: "no-store" }).catch(() => {});
      },
    },
    createScheduler(mode) {
      if (mode !== "display" && mode !== "throughput") throw new Error("invalid frame mode");
      const waiting = new Map();
      const scheduler = {
        mode,
        fire(token) { const fn = waiting.get(token); if (!fn) return false; waiting.delete(token); fn(now()); return true; },
        request(fn) {
          if (closed) throw new Error("native GPU wire closed");
          const token = nextToken++;
          waiting.set(token, fn); tickRequested.set(token, now());
          queueControl(encodeWireFrame(WIRE.TICK_REQUEST, { engine, a: token }));
          return token;
        },
        cancel(token) { if (waiting.delete(token)) { tickRequested.delete(token); if (!closed) queueControl(encodeWireFrame(WIRE.TICK_CANCEL, { engine, a: token })); } },
        dispose() { for (const token of [...waiting.keys()]) scheduler.cancel(token); schedulers.delete(scheduler); },
      };
      schedulers.add(scheduler);
      return scheduler;
    },
  };
  return wire;
}

// Session claim from the page (main thread). The macOS host injects `window.__ntNativeGpuOffer` only when it
// was started with native GPU enabled; the claim succeeds once per page load and returns the capability.
export async function claimNativeGpu(scope = globalThis) {
  const offer = scope.__ntNativeGpuOffer;
  if (!offer || typeof offer.endpoint !== "string") return null;
  const endpoint = new URL(offer.endpoint, scope.location.href).href;
  const response = await fetch(`${endpoint}session`, { method: "POST", cache: "no-store" });
  if (!response.ok) throw new Error(`native GPU session claim refused: HTTP ${response.status} ${await response.text().catch(() => "")}`);
  const claimed = await response.json();
  return Object.freeze({ ...claimed, endpoint });
}

// Page-side canvas geometry reporter for native presentation: coalesced to one measurement per animation frame
// and posted only when something changed. Moves without a resize (DOM above the canvas changing) are caught by
// observing document layout and mutations, so nothing is measured while the page is idle.
export function reportNativeGeometry(scope, canvas, post) {
  let closed = false, frame = null, revision = 0, last = "", resize = null, mutations = null, media = null;
  const doc = scope.document;
  const measure = () => {
    frame = null;
    if (closed) return;
    const rect = canvas.getBoundingClientRect();
    const style = scope.getComputedStyle?.(canvas);
    const hidden = doc?.visibilityState === "hidden" || style?.visibility === "hidden" || style?.display === "none";
    const report = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: scope.devicePixelRatio ?? 1, visible: !hidden,
      opaqueComposite: !style || (style.opacity === "1" && style.filter === "none" && style.mixBlendMode === "normal"), axisAligned: true };
    const key = JSON.stringify(report);
    if (key === last) return;
    last = key;
    post({ ...report, revision: ++revision });
  };
  // rAF does not run for hidden/occluded pages; measure on a microtask then so the host learns visible:false.
  const changed = () => {
    if (closed || frame !== null) return;
    if (scope.requestAnimationFrame && doc?.visibilityState !== "hidden") frame = scope.requestAnimationFrame(measure);
    else { frame = 0; queueMicrotask(measure); }
  };
  const arm = () => {
    media?.removeEventListener?.("change", onDpr);
    media = scope.matchMedia?.(`(resolution: ${scope.devicePixelRatio ?? 1}dppx)`) ?? null;
    media?.addEventListener?.("change", onDpr, { once: true });
  };
  const onDpr = () => { changed(); arm(); };
  if (scope.ResizeObserver) {
    resize = new scope.ResizeObserver(changed);
    for (const target of [canvas, doc?.documentElement, doc?.body]) if (target) resize.observe(target);
  }
  if (scope.MutationObserver && doc?.body) {
    mutations = new scope.MutationObserver(changed);
    mutations.observe(doc.body, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  scope.addEventListener?.("resize", changed); scope.addEventListener?.("scroll", changed, { passive: true, capture: true });
  doc?.addEventListener?.("visibilitychange", changed);
  arm(); changed();
  return {
    refresh: changed,
    dispose() {
      if (closed) return;
      closed = true; resize?.disconnect(); mutations?.disconnect();
      scope.removeEventListener?.("resize", changed); scope.removeEventListener?.("scroll", changed, { capture: true });
      doc?.removeEventListener?.("visibilitychange", changed);
      media?.removeEventListener?.("change", onDpr);
      if (frame) scope.cancelAnimationFrame?.(frame);
    },
  };
}
