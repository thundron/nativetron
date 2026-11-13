import { createFrameScheduler } from "../gpu/frame-scheduler.js";
import {
  GPU_MAX_BATCH_BYTES, GPU_MAX_PENDING_REQUESTS, GPU_EVENT_MAP_READY, GPU_EVENT_DEVICE_LOST, GPU_EVENT_ERROR,
  GPU_STATUS_OK, GPU_STATUS_ERROR, GPU_STATUS_LOST,
} from "../gpu/gpu-host.generated.js";

// Transport core for executing the reactor's GPU op stream outside this JavaScript realm (a native
// WebGPU executor). It keeps the reactor's synchronous `gpuPresent(batch, uploads, readbacks)` import
// contract while delivery to the executor is asynchronous. See engine/NATIVE-GPU.md for the wire
// contract and what a platform bridge must provide. Nothing here decodes or executes GPU operations.

// Guest staging limits (gpu/ops.json maxBatchBytes/maxUploadBytes/maxReadbackBytes; checked by the test).
export const NATIVE_GPU_MAX_COMMAND_BYTES = GPU_MAX_BATCH_BYTES;
export const NATIVE_GPU_MAX_UPLOAD_BYTES = 536870912;
export const NATIVE_GPU_MAX_READBACK_BYTES = 16777216;
export const NATIVE_GPU_DEFAULT_CHUNK_BYTES = 4 * 1048576;
export const NATIVE_GPU_DEFAULT_SUBMISSIONS = 8;
export const NATIVE_GPU_DEFAULT_FRAMES_IN_FLIGHT = 2;
export const NATIVE_GPU_DEFAULT_ACK_TIMEOUT_MS = 30000;
const MAX_SUBMISSION_BYTES = NATIVE_GPU_MAX_COMMAND_BYTES + NATIVE_GPU_MAX_UPLOAD_BYTES;
const FRAME_MODES = new Set(["display", "throughput"]);

export class NativeGpuError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeGpuError";
    this.code = code;
  }
}

const isU32 = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const chunkCount = (bytes, chunk) => Math.ceil(bytes / chunk);
const text = (error) => error instanceof Error ? error.message : String(error);

// Chunks needed for one submission: a header plus whole chunks of commands and uploads.
export function nativeGpuChunks(commandBytes, uploadBytes, chunkBytes = NATIVE_GPU_DEFAULT_CHUNK_BYTES) {
  return 1 + chunkCount(commandBytes, chunkBytes) + chunkCount(uploadBytes, chunkBytes);
}

export function createNativeGpuHost(options) {
  const { transport, getMemory } = options ?? {};
  if (!transport || typeof transport.send !== "function") throw new NativeGpuError("invalid-options", "native GPU host requires transport.send");
  if (typeof getMemory !== "function") throw new NativeGpuError("invalid-options", "native GPU host requires getMemory");
  const engine = options.engineGeneration;
  if (!Number.isSafeInteger(engine) || engine < 1) throw new NativeGpuError("invalid-options", "engineGeneration must be a positive integer");
  const scope = options.scope ?? globalThis;
  const chunkBytes = options.chunkBytes ?? NATIVE_GPU_DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 4096 || chunkBytes % 4) throw new NativeGpuError("invalid-options", "chunkBytes must be a multiple of 4 and at least 4096");
  // Bounds may be raised, never lowered below one maximal guest flush: narrowing would refuse batches
  // the guest encoder legitimately produces.
  const maxQueuedBytes = options.maxQueuedBytes ?? MAX_SUBMISSION_BYTES;
  const maxQueuedSubmissions = options.maxQueuedSubmissions ?? NATIVE_GPU_DEFAULT_SUBMISSIONS;
  const maxQueuedChunks = options.maxQueuedChunks ?? nativeGpuChunks(maxQueuedBytes, 0, chunkBytes) + 2 * maxQueuedSubmissions;
  const maxReadbackBytes = options.maxReadbackBytes ?? NATIVE_GPU_MAX_READBACK_BYTES;
  const maxFramesInFlight = options.maxFramesInFlight ?? NATIVE_GPU_DEFAULT_FRAMES_IN_FLIGHT;
  const ackTimeoutMs = options.ackTimeoutMs ?? NATIVE_GPU_DEFAULT_ACK_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < MAX_SUBMISSION_BYTES) throw new NativeGpuError("invalid-options", `maxQueuedBytes must admit one maximal flush (${MAX_SUBMISSION_BYTES} bytes)`);
  if (!Number.isSafeInteger(maxQueuedSubmissions) || maxQueuedSubmissions < 1) throw new NativeGpuError("invalid-options", "maxQueuedSubmissions must be positive");
  if (!Number.isSafeInteger(maxQueuedChunks) || maxQueuedChunks < nativeGpuChunks(NATIVE_GPU_MAX_COMMAND_BYTES, NATIVE_GPU_MAX_UPLOAD_BYTES, chunkBytes)) throw new NativeGpuError("invalid-options", "maxQueuedChunks must admit one maximal flush");
  if (!Number.isSafeInteger(maxReadbackBytes) || maxReadbackBytes < NATIVE_GPU_MAX_READBACK_BYTES) throw new NativeGpuError("invalid-options", "maxReadbackBytes must admit the guest readback arena");
  if (!Number.isSafeInteger(maxFramesInFlight) || maxFramesInFlight < 1) throw new NativeGpuError("invalid-options", "maxFramesInFlight must be positive");
  if (!(ackTimeoutMs > 0)) throw new NativeGpuError("invalid-options", "ackTimeoutMs must be positive");
  const setTimer = options.setTimer ?? ((fn, ms) => (scope.setTimeout ?? globalThis.setTimeout)(fn, ms));
  const clearTimer = options.clearTimer ?? ((token) => (scope.clearTimeout ?? globalThis.clearTimeout)(token));
  const createScheduler = options.createScheduler ?? ((mode) => createFrameScheduler(mode, scope, options));

  let frameMode = options.frameMode ?? "display";
  if (!FRAME_MODES.has(frameMode)) throw new NativeGpuError("invalid-options", "invalid frame mode");
  let scheduler = createScheduler(frameMode);
  let stopped = false, failure = null, blocked = false, pumping = false;
  let sequence = 0, sentThrough = 0, ackedThrough = 0;
  let queuedBytes = 0, queuedChunks = 0, readbackBytes = 0;
  let device = 0, frameToken = null, frameWaiting = false, frameNumber = 0, currentFrame = 0, ackTimer = null;
  const outbox = [];        // messages not yet accepted by transport.send, in wire order
  const unacked = [];       // { sequence, bytes, chunks, frame } until the executor acknowledges consumption
  const frames = new Map(); // frame number -> unacknowledged submissions produced by that frame callback
  const readbacks = new Map(); // requestId -> { offset, length, received, data } while chunks arrive
  const stats = {
    batches: 0, frames: 0, uploadedBytes: 0, copiedBytes: 0, chunksSent: 0, acknowledged: 0,
    staleRejected: 0, frameDeferrals: 0, rejectedBatches: 0, peakQueuedBytes: 0, peakQueuedSubmissions: 0,
  };

  const emit = (event) => {
    if (stopped) return;
    queueMicrotask(() => {
      if (stopped) return;
      try { options.onEvent?.(event); }
      catch (error) { fail("event-callback-failed", `GPU event callback failed: ${text(error)}`, error); }
    });
  };
  const errorEvent = (message, requestId = 0, handle = 0) => emit({ type: GPU_EVENT_ERROR, requestId, handle, status: GPU_STATUS_ERROR, message });

  const release = () => {
    outbox.length = 0; unacked.length = 0; frames.clear(); readbacks.clear();
    queuedBytes = 0; queuedChunks = 0; readbackBytes = 0; blocked = false;
    if (ackTimer !== null) { try { clearTimer(ackTimer); } catch {} ackTimer = null; }
    if (frameToken !== null) { try { scheduler.cancel(frameToken); } catch {} frameToken = null; }
    frameWaiting = false;
    try { scheduler.dispose(); } catch {}
  };
  const close = (reason) => { try { transport.close?.({ engine, reason }); } catch {} };
  // Fatal for this engine generation: the executor's state can no longer be kept in step with the guest.
  function fail(code, message, cause) {
    if (stopped) return failure;
    failure = new NativeGpuError(code, message, cause);
    stopped = true;
    release();
    close(code);
    const error = failure;
    queueMicrotask(() => { try { options.onFailure?.(error); } catch {} });
    return failure;
  }

  const armAckTimer = () => {
    if (ackTimer !== null) { clearTimer(ackTimer); ackTimer = null; }
    if (!unacked.length || stopped) return;
    ackTimer = setTimer(() => { ackTimer = null; fail("ack-timeout", `native GPU executor did not acknowledge submission ${unacked[0]?.sequence} within ${ackTimeoutMs} ms`); }, ackTimeoutMs);
  };
  const schedulePump = () => { if (!pumping && !blocked && !stopped && outbox.length) { pumping = true; queueMicrotask(pump); } };
  function pump() {
    pumping = false;
    while (!stopped && !blocked && outbox.length) {
      const message = outbox[0];
      // Marked sent before the call: a loopback transport may acknowledge synchronously inside send.
      const previous = sentThrough;
      if (message.last) sentThrough = message.sequence;
      let accepted;
      try { accepted = transport.send(message, message.bytes ? [message.bytes.buffer] : []); }
      catch (error) { fail("transport-failed", `native GPU transport send failed: ${text(error)}`, error); return; }
      if (stopped) return;
      if (accepted === false) { sentThrough = previous; blocked = true; return; }
      outbox.shift();
      if (message.bytes) stats.chunksSent++;
    }
  }

  const canFrame = () => frames.size < maxFramesInFlight && unacked.length < maxQueuedSubmissions;
  const tick = (time) => {
    frameToken = null;
    if (stopped) return;
    if (!canFrame()) { frameWaiting = true; stats.frameDeferrals++; return; }
    frameNumber++; currentFrame = frameNumber; stats.frames++;
    try { options.onFrame?.(time); }
    catch (error) { errorEvent(text(error)); }
    finally { currentFrame = 0; }
  };
  const requestFrame = () => {
    if (stopped || frameToken !== null || frameWaiting) return;
    try { frameToken = scheduler.request(tick); }
    catch (error) { fail("scheduler-failed", `native GPU frame scheduler failed: ${text(error)}`, error); }
  };
  const control = (message) => { outbox.push({ engine, ...message }); schedulePump(); };

  const acknowledge = (through) => {
    if (!isCount(through) || through <= ackedThrough) { stats.staleRejected++; return false; }
    if (through > sentThrough) { fail("protocol-violation", `native GPU acknowledgement ${through} precedes delivery (sent through ${sentThrough})`); return false; }
    while (unacked.length && unacked[0].sequence <= through) {
      const done = unacked.shift();
      queuedBytes -= done.bytes; queuedChunks -= done.chunks; stats.acknowledged++;
      if (done.frame) { const left = frames.get(done.frame) - 1; if (left) frames.set(done.frame, left); else frames.delete(done.frame); }
    }
    ackedThrough = through;
    armAckTimer();
    if (frameWaiting && canFrame()) { frameWaiting = false; requestFrame(); }
    return true;
  };

  const currentDevice = (value) => {
    if (!isCount(value) || value < device) { stats.staleRejected++; return false; }
    device = value;
    return true;
  };
  const readbackChunk = (message) => {
    const { requestId, offset, length, at, bytes } = message;
    if (!isU32(requestId) || requestId === 0 || !isU32(offset) || !isCount(length) || length === 0 || length > NATIVE_GPU_MAX_READBACK_BYTES
      || !isCount(at) || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || at + bytes.byteLength > length) {
      fail("protocol-violation", "malformed native GPU readback chunk"); return false;
    }
    let entry = readbacks.get(requestId);
    if (!entry) {
      if (at !== 0) { fail("protocol-violation", "native GPU readback chunk out of order"); return false; }
      if (readbacks.size >= GPU_MAX_PENDING_REQUESTS || readbackBytes + length > maxReadbackBytes) { fail("readback-exhausted", "native GPU readback staging exhausted"); return false; }
      // A single whole-buffer chunk is adopted: transport messages transfer ownership to this host.
      const whole = at === 0 && bytes.byteLength === length && bytes.byteOffset === 0 && bytes.buffer.byteLength === length;
      entry = { offset, length, received: 0, data: whole ? bytes : new Uint8Array(length), device };
      readbacks.set(requestId, entry); readbackBytes += length;
      if (whole) { entry.received = length; return true; }
    }
    if (entry.offset !== offset || entry.length !== length || entry.received !== at) { fail("protocol-violation", "native GPU readback chunk out of order"); return false; }
    entry.data.set(bytes, at);
    entry.received += bytes.byteLength;
    return true;
  };
  const deliverEvent = (raw) => {
    if (!raw || typeof raw !== "object" || !Number.isInteger(raw.type) || raw.type < 1 || raw.type > 9 || !isU32(raw.requestId ?? 0) || !isU32(raw.handle ?? 0)
      || !Number.isInteger(raw.status) || raw.status < 0 || raw.status > 3) { fail("protocol-violation", "malformed native GPU event"); return false; }
    const { data: _ignored, ...event } = raw;
    event.requestId = raw.requestId ?? 0; event.handle = (raw.handle ?? 0) >>> 0;
    if (event.type === GPU_EVENT_MAP_READY && event.requestId) {
      const staged = readbacks.get(event.requestId);
      if (staged) { readbacks.delete(event.requestId); readbackBytes -= staged.length; }
      if (event.status === GPU_STATUS_OK) {
        if (!staged || staged.received !== staged.length || staged.offset !== event.offset || staged.length !== event.length) {
          fail("protocol-violation", "native GPU MAP_READY without its complete readback bytes"); return false;
        }
        event.data = staged.data;
      }
    }
    if (event.type === GPU_EVENT_DEVICE_LOST) {
      // Requests of the lost device settle before this event; nothing later may carry its generation.
      device++;
      for (const [id, entry] of readbacks) if (entry.device < device) { readbacks.delete(id); readbackBytes -= entry.length; }
      if (frameToken !== null) { try { scheduler.cancel(frameToken); } catch {} frameToken = null; }
      frameWaiting = false;
    }
    emit(event);
    return true;
  };

  const host = {
    engineGeneration: engine,
    // Synchronous gpuPresent import. Owns copies of commands and the used upload range before it returns;
    // the guest resets and rewrites both arenas immediately. The readback view is only measured, never
    // retained or written: readback bytes return through MAP_READY events to the guest readback export.
    apply(batch, uploads, readbacks) {
      if (failure) throw failure;
      if (stopped) return false;
      const memory = getMemory();
      if (!(batch instanceof Uint8Array) || !(uploads instanceof Uint8Array) || !(readbacks instanceof Uint8Array)
        || batch.buffer !== memory || uploads.buffer !== memory || readbacks.buffer !== memory) {
        stats.rejectedBatches++; errorEvent("GPU batch and arenas must share reactor memory"); return false;
      }
      const commandBytes = batch.byteLength, uploadBytes = uploads.byteLength, readbackArena = readbacks.byteLength;
      if (commandBytes > NATIVE_GPU_MAX_COMMAND_BYTES || uploadBytes > NATIVE_GPU_MAX_UPLOAD_BYTES || readbackArena > NATIVE_GPU_MAX_READBACK_BYTES) {
        stats.rejectedBatches++; errorEvent("GPU batch limit exceeded"); return false;
      }
      const bytes = commandBytes + uploadBytes, chunks = nativeGpuChunks(commandBytes, uploadBytes, chunkBytes);
      // gpuPresent cannot report backpressure and reliable commands are never dropped: overflowing any
      // bound ends this engine generation (the throw unwinds the guest export; onFailure also fires).
      if (queuedBytes + bytes > maxQueuedBytes || unacked.length + 1 > maxQueuedSubmissions || queuedChunks + chunks > maxQueuedChunks) {
        throw fail("queue-exhausted", `native GPU queue exhausted (${unacked.length} submissions, ${queuedBytes} bytes, ${queuedChunks} chunks queued; flush needs ${bytes} bytes)`);
      }
      const seq = ++sequence, messages = [];
      messages.push({ kind: "submit", engine, sequence: seq, commandBytes, uploadBytes, readbackBytes: readbackArena, chunks });
      let index = 1;
      const copy = (source, section) => {
        for (let offset = 0; offset < source.byteLength; offset += chunkBytes) {
          const owned = source.slice(offset, Math.min(source.byteLength, offset + chunkBytes));
          messages.push({ kind: "chunk", engine, sequence: seq, index: index++, section, offset, bytes: owned, last: false });
        }
      };
      try { copy(batch, "commands"); copy(uploads, "uploads"); }
      catch (error) { sequence--; throw fail("copy-failed", `native GPU staging copy failed: ${text(error)}`, error); }
      messages[messages.length - 1].last = true;
      unacked.push({ sequence: seq, bytes, chunks, frame: currentFrame });
      if (currentFrame) frames.set(currentFrame, (frames.get(currentFrame) ?? 0) + 1);
      queuedBytes += bytes; queuedChunks += chunks;
      stats.batches++; stats.uploadedBytes += uploadBytes; stats.copiedBytes += bytes;
      stats.peakQueuedBytes = Math.max(stats.peakQueuedBytes, queuedBytes);
      stats.peakQueuedSubmissions = Math.max(stats.peakQueuedSubmissions, unacked.length);
      for (const message of messages) outbox.push(message);
      if (ackTimer === null) armAckTimer();
      schedulePump();
      return true;
    },
    // Native → host messages, in executor order. Returns false when ignored as stale or after a
    // protocol violation (which fails the host). Never throws into the platform bridge.
    receive(message) {
      if (stopped) return false;
      try {
        if (!message || typeof message !== "object") { fail("protocol-violation", "malformed native GPU message"); return false; }
        if (message.engine !== engine) { stats.staleRejected++; return false; }
        switch (message.type) {
          case "ack": return acknowledge(message.sequence);
          case "event": return currentDevice(message.device) && deliverEvent(message.event);
          case "readback": return currentDevice(message.device) && readbackChunk(message);
          case "frame-request": if (!currentDevice(message.device)) return false; requestFrame(); return true;
          case "failed": fail("executor-failed", `native GPU executor failed: ${String(message.message ?? "unknown")}`); return false;
          default: fail("protocol-violation", `unknown native GPU message ${String(message.type)}`); return false;
        }
      } catch (error) { fail("internal-error", `native GPU host failed: ${text(error)}`, error); return false; }
    },
    // The platform transport refused a send (returned false) and can accept more now.
    resume() { if (!stopped) { blocked = false; schedulePump(); } },
    requestFrame,
    setFrameMode(mode) {
      if (stopped) throw new Error("GPU host disposed");
      if (mode === frameMode) return;
      if (!FRAME_MODES.has(mode)) throw new Error("invalid frame mode");
      const next = createScheduler(mode);
      const requested = frameToken !== null;
      if (requested) scheduler.cancel(frameToken);
      scheduler.dispose(); scheduler = next; frameMode = mode; frameToken = null;
      control({ kind: "frame-mode", mode });
      if (requested) requestFrame();
    },
    get frameMode() { return frameMode; },
    dispose() {
      if (stopped) return;
      stopped = true;
      release();
      close("disposed");
    },
    stats,
    get failure() { return failure; },
    get disposed() { return stopped; },
    get idle() { return frameToken === null && !frameWaiting; },
    get queue() { return { submissions: unacked.length, bytes: queuedBytes, chunks: queuedChunks, unsent: outbox.length, framesInFlight: frames.size, sentThrough, ackedThrough }; },
    get pendingReadbacks() { return readbacks.size; },
    get deviceGeneration() { return device; },
    // The JS host's WebGPU objects and handle table live in the native executor.
    handles: null, device: null, adapter: null,
  };
  control({ kind: "open", frameMode, limits: { commandBytes: NATIVE_GPU_MAX_COMMAND_BYTES, uploadBytes: NATIVE_GPU_MAX_UPLOAD_BYTES, readbackBytes: NATIVE_GPU_MAX_READBACK_BYTES, chunkBytes } });
  return host;
}
