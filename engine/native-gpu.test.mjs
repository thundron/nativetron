import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createNativeGpuHost, nativeGpuChunks, NativeGpuError,
  NATIVE_GPU_MAX_COMMAND_BYTES, NATIVE_GPU_MAX_UPLOAD_BYTES, NATIVE_GPU_MAX_READBACK_BYTES,
} from "./native-gpu.js";

const ENGINE = 7;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Doubles: a recording transport, a manually driven frame scheduler and timers. None performs a native crossing.
function fixture(overrides = {}) {
  const memory = new ArrayBuffer(1 << 20);
  const sent = [], closed = [], events = [], failures = [], frames = [];
  const transport = { accept: true, send(message, transfer) { if (!this.accept) return false; sent.push({ message, transfer }); this.onSend?.(message); return true; }, close(info) { closed.push(info); } };
  const scheduled = new Map(); let nextId = 1;
  const schedulers = [];
  const createScheduler = (mode) => {
    const scheduler = { mode, disposed: false, request(fn) { const id = nextId++; scheduled.set(id, fn); return id; }, cancel(id) { scheduled.delete(id); }, dispose() { this.disposed = true; } };
    schedulers.push(scheduler); return scheduler;
  };
  const timers = new Map(); let nextTimer = 1;
  const host = createNativeGpuHost({
    transport, getMemory: () => memory, engineGeneration: ENGINE, createScheduler,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; }, clearTimer: (id) => timers.delete(id),
    onEvent: (event) => events.push(event), onFailure: (error) => failures.push(error),
    onFrame: (time) => { frames.push(time); overrides.onFrame?.(time, host); },
    ...overrides.options,
  });
  const fireFrame = (time = 16) => { const [id, fn] = scheduled.entries().next().value ?? []; assert.ok(fn, "no frame scheduled"); scheduled.delete(id); fn(time); };
  const arenas = (commands = 32, uploads = 0, readbacks = 0) => ({
    batch: new Uint8Array(memory, 0, commands), uploads: new Uint8Array(memory, 4096, uploads), readbacks: new Uint8Array(memory, 262144, readbacks),
  });
  const submissions = () => sent.map((entry) => entry.message).filter((message) => message.kind === "submit");
  const chunks = (sequence) => sent.map((entry) => entry.message).filter((message) => message.kind === "chunk" && message.sequence === sequence);
  const ack = (sequence) => host.receive({ type: "ack", engine: ENGINE, sequence });
  return { memory, host, transport, sent, closed, events, failures, frames, scheduled, schedulers, timers, fireFrame, arenas, submissions, chunks, ack };
}

test("limits mirror gpu/ops.json and cannot be narrowed below one maximal guest flush", () => {
  const spec = JSON.parse(readFileSync(new URL("../gpu/ops.json", import.meta.url)));
  assert.equal(NATIVE_GPU_MAX_COMMAND_BYTES, spec.maxBatchBytes);
  assert.equal(NATIVE_GPU_MAX_UPLOAD_BYTES, spec.maxUploadBytes);
  assert.equal(NATIVE_GPU_MAX_READBACK_BYTES, spec.maxReadbackBytes);
  const base = { transport: { send() { return true; } }, getMemory: () => new ArrayBuffer(8), engineGeneration: 1, createScheduler: () => ({ request() {}, cancel() {}, dispose() {} }) };
  assert.throws(() => createNativeGpuHost({ ...base, maxQueuedBytes: 16 << 20 }), /maximal flush/);
  assert.throws(() => createNativeGpuHost({ ...base, maxQueuedChunks: 8 }), /maximal flush/);
  assert.throws(() => createNativeGpuHost({ ...base, maxReadbackBytes: 1 << 20 }), /readback arena/);
  assert.throws(() => createNativeGpuHost({ ...base, engineGeneration: 0 }), /engineGeneration/);
  assert.throws(() => createNativeGpuHost({ ...base, transport: {} }), /transport.send/);
  assert.ok(createNativeGpuHost({ ...base, maxQueuedBytes: 1 << 30 }));
});

test("apply owns command and upload copies before returning; arenas may be overwritten immediately", async () => {
  const f = fixture();
  const { batch, uploads, readbacks } = f.arenas(64, 128, 256);
  batch.fill(0x11); uploads.fill(0x22); readbacks.fill(0x33);
  assert.equal(f.host.apply(batch, uploads, readbacks), true);
  // The guest flush resets and reuses both arenas before any asynchronous delivery happens.
  batch.fill(0xee); uploads.fill(0xdd);
  await tick();
  const [header] = f.submissions();
  assert.deepEqual({ ...header }, { kind: "submit", engine: ENGINE, sequence: 1, commandBytes: 64, uploadBytes: 128, readbackBytes: 256, chunks: 3 });
  const [commands, upload] = f.chunks(1);
  assert.deepEqual([...new Set(commands.bytes)], [0x11]);
  assert.deepEqual([...new Set(upload.bytes)], [0x22]);
  for (const { message, transfer } of f.sent.filter((entry) => entry.message.bytes)) {
    assert.notEqual(message.bytes.buffer, f.memory, "chunk must not alias reactor memory");
    assert.equal(message.bytes.byteOffset, 0); assert.equal(message.bytes.byteLength, message.bytes.buffer.byteLength);
    assert.deepEqual(transfer, [message.bytes.buffer]);
  }
  assert.deepEqual([...new Set(readbacks)], [0x33], "callback readback view is never written");
  assert.equal(f.sent[0].message.kind, "open");
  assert.equal(f.host.stats.copiedBytes, 192);
});

test("large flushes are split into ordered, bounded chunks that reassemble exactly", async () => {
  const f = fixture({ options: { chunkBytes: 4096 } });
  const { batch, uploads, readbacks } = f.arenas(10000, 9000, 0);
  for (let i = 0; i < batch.length; i++) batch[i] = i * 7;
  for (let i = 0; i < uploads.length; i++) uploads[i] = i * 13;
  const expectBatch = batch.slice(), expectUploads = uploads.slice();
  f.host.apply(batch, uploads, readbacks);
  assert.equal(f.host.queue.chunks, nativeGpuChunks(10000, 9000, 4096));
  await tick();
  const parts = f.chunks(1);
  assert.equal(parts.length, 3 + 3);
  assert.deepEqual(parts.map((part) => part.index), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parts.map((part) => part.last), [false, false, false, false, false, true]);
  assert.ok(parts.every((part) => part.bytes.byteLength <= 4096));
  const join = (section, length) => { const out = new Uint8Array(length); for (const part of parts.filter((p) => p.section === section)) out.set(part.bytes, part.offset); return out; };
  assert.deepEqual(join("commands", 10000), expectBatch);
  assert.deepEqual(join("uploads", 9000), expectUploads);
});

test("transport refusal holds order and resumes without loss", async () => {
  const f = fixture();
  f.transport.accept = false;
  const a = f.arenas(16);
  f.host.apply(a.batch, a.uploads, a.readbacks);
  f.host.apply(a.batch, a.uploads, a.readbacks);
  await tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.host.queue.unsent, 5);
  assert.equal(f.ack(1), false, "an acknowledgement of an unsent submission is a protocol violation");
  assert.equal(f.host.failure.code, "protocol-violation");

  const g = fixture();
  g.transport.accept = false;
  const b = g.arenas(16);
  g.host.apply(b.batch, b.uploads, b.readbacks);
  g.host.apply(b.batch, b.uploads, b.readbacks);
  await tick();
  g.transport.accept = true; g.host.resume();
  await tick();
  assert.deepEqual(g.sent.map(({ message }) => `${message.kind}:${message.sequence ?? ""}`), ["open:", "submit:1", "chunk:1", "submit:2", "chunk:2"]);
  assert.equal(g.host.queue.sentThrough, 2);
});

test("acknowledgements are cumulative, release bounds, and stale ones are rejected", async () => {
  const f = fixture();
  const a = f.arenas(32, 64);
  for (let i = 0; i < 3; i++) f.host.apply(a.batch, a.uploads, a.readbacks);
  await tick();
  assert.deepEqual({ ...f.host.queue, unsent: 0 }, { submissions: 3, bytes: 288, chunks: 9, unsent: 0, framesInFlight: 0, sentThrough: 3, ackedThrough: 0 });
  assert.equal(f.ack(2), true);
  assert.equal(f.host.queue.submissions, 1); assert.equal(f.host.queue.bytes, 96);
  assert.equal(f.ack(2), false, "duplicate");
  assert.equal(f.ack(1), false, "regressing");
  assert.equal(f.host.receive({ type: "ack", engine: ENGINE - 1, sequence: 3 }), false, "older engine generation");
  assert.equal(f.host.stats.staleRejected, 3);
  assert.equal(f.host.failure, null);
  assert.equal(f.ack(3), true);
  assert.equal(f.host.queue.bytes, 0);
  assert.equal(f.timers.size, 0, "no acknowledgement timer while nothing is outstanding");
  assert.equal(f.ack(9), false);
  assert.equal(f.host.failure.code, "protocol-violation");
});

test("queue exhaustion is an explicit fatal failure, never a silent drop", async () => {
  const f = fixture({ options: { maxQueuedSubmissions: 2 } });
  const a = f.arenas(32, 32);
  f.host.apply(a.batch, a.uploads, a.readbacks);
  f.host.apply(a.batch, a.uploads, a.readbacks);
  assert.throws(() => f.host.apply(a.batch, a.uploads, a.readbacks), (error) => error instanceof NativeGpuError && error.code === "queue-exhausted");
  assert.throws(() => f.host.apply(a.batch, a.uploads, a.readbacks), /queue exhausted/, "the failure is sticky");
  assert.deepEqual(f.host.queue, { submissions: 0, bytes: 0, chunks: 0, unsent: 0, framesInFlight: 0, sentThrough: 0, ackedThrough: 0 });
  assert.deepEqual(f.closed, [{ engine: ENGINE, reason: "queue-exhausted" }]);
  await tick();
  assert.equal(f.sent.length, 0, "nothing is sent once the generation has failed");
  assert.equal(f.failures.length, 1); assert.equal(f.failures[0].code, "queue-exhausted");
  assert.equal(f.host.receive({ type: "ack", engine: ENGINE, sequence: 1 }), false);
});

test("frame credits gate frame callbacks; several flushes inside one frame share one credit", async () => {
  const f = fixture({
    options: { maxFramesInFlight: 1 },
    onFrame: (_time, host) => { const a = f.arenas(16); host.apply(a.batch, a.uploads, a.readbacks); host.apply(a.batch, a.uploads, a.readbacks); },
  });
  assert.equal(f.host.receive({ type: "frame-request", engine: ENGINE, device: 0 }), true);
  f.host.receive({ type: "frame-request", engine: ENGINE, device: 0 });
  assert.equal(f.scheduled.size, 1, "one outstanding frame request");
  f.fireFrame(16);
  assert.deepEqual(f.frames, [16]);
  assert.equal(f.host.queue.framesInFlight, 1); assert.equal(f.host.queue.submissions, 2);
  f.host.receive({ type: "frame-request", engine: ENGINE, device: 0 });
  f.fireFrame(32);
  assert.deepEqual(f.frames, [16], "frame deferred while its predecessor is unacknowledged");
  assert.equal(f.host.idle, false); assert.equal(f.host.stats.frameDeferrals, 1);
  await tick();
  f.ack(1);
  assert.equal(f.scheduled.size, 0, "a partially consumed frame keeps its credit");
  f.ack(2);
  assert.equal(f.scheduled.size, 1, "the credit returns and the frame is paced on the next scheduler tick");
  f.fireFrame(48);
  assert.deepEqual(f.frames, [16, 48]);
});

test("submissions outside frame callbacks are bounded only by the hard queue limits", () => {
  const f = fixture({ options: { maxQueuedSubmissions: 3, maxFramesInFlight: 1 } });
  const a = f.arenas(16);
  // An event or message export may flush repeatedly; frame gating does not bound it.
  for (let i = 0; i < 3; i++) f.host.apply(a.batch, a.uploads, a.readbacks);
  assert.equal(f.host.queue.framesInFlight, 0);
  assert.throws(() => f.host.apply(a.batch, a.uploads, a.readbacks), /queue exhausted/);
});

test("events are delivered in order on later microtasks; readback bytes are reassembled for MAP_READY", async () => {
  const f = fixture();
  const bytes = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
  assert.equal(f.host.receive({ type: "event", engine: ENGINE, device: 1, event: { type: 1, requestId: 1, handle: 0, status: 0, available: true, features: [] } }), true);
  f.host.receive({ type: "readback", engine: ENGINE, device: 1, requestId: 5, offset: 64, length: 12, at: 0, bytes: bytes.subarray(0, 8) });
  f.host.receive({ type: "readback", engine: ENGINE, device: 1, requestId: 5, offset: 64, length: 12, at: 8, bytes: bytes.subarray(8) });
  assert.equal(f.host.pendingReadbacks, 1);
  f.host.receive({ type: "event", engine: ENGINE, device: 1, event: { type: 3, requestId: 5, handle: 0x100001, status: 0, offset: 64, length: 12, data: new Uint8Array(1) } });
  f.host.receive({ type: "event", engine: ENGINE, device: 1, event: { type: 4, requestId: 6, handle: 0, status: 0 } });
  assert.equal(f.events.length, 0, "no synchronous delivery into the embedding");
  await tick();
  assert.deepEqual(f.events.map((event) => event.type), [1, 3, 4]);
  assert.deepEqual(f.events[1].data, bytes, "data comes only from readback chunks");
  assert.equal(f.events[1].offset, 64);
  assert.equal(f.host.pendingReadbacks, 0);

  const whole = new Uint8Array(8).fill(9);
  f.host.receive({ type: "readback", engine: ENGINE, device: 1, requestId: 8, offset: 0, length: 8, at: 0, bytes: whole });
  f.host.receive({ type: "event", engine: ENGINE, device: 1, event: { type: 3, requestId: 8, handle: 1, status: 0, offset: 0, length: 8 } });
  await tick();
  assert.equal(f.events.at(-1).data, whole, "a whole transferred chunk is adopted without another copy");
});

test("cancelled readbacks discard partial bytes; malformed readback sequences fail closed", async () => {
  const f = fixture();
  f.host.receive({ type: "readback", engine: ENGINE, device: 0, requestId: 2, offset: 0, length: 16, at: 0, bytes: new Uint8Array(8) });
  f.host.receive({ type: "event", engine: ENGINE, device: 0, event: { type: 3, requestId: 2, handle: 1, status: 2, message: "cancelled" } });
  await tick();
  assert.equal(f.events[0].data, undefined); assert.equal(f.host.pendingReadbacks, 0);

  const g = fixture();
  g.host.receive({ type: "event", engine: ENGINE, device: 0, event: { type: 3, requestId: 2, handle: 1, status: 0, offset: 0, length: 16 } });
  assert.equal(g.host.failure.code, "protocol-violation", "MAP_READY OK without bytes");

  const h = fixture();
  h.host.receive({ type: "readback", engine: ENGINE, device: 0, requestId: 2, offset: 0, length: 16, at: 0, bytes: new Uint8Array(8) });
  h.host.receive({ type: "readback", engine: ENGINE, device: 0, requestId: 2, offset: 0, length: 16, at: 4, bytes: new Uint8Array(4) });
  assert.equal(h.host.failure.code, "protocol-violation", "out-of-order chunk");
  assert.equal(h.host.pendingReadbacks, 0, "released on failure");
});

test("device generations reject events, readbacks and frame requests from a lost device", async () => {
  const f = fixture();
  f.host.receive({ type: "event", engine: ENGINE, device: 3, event: { type: 1, requestId: 1, status: 0 } });
  f.host.receive({ type: "readback", engine: ENGINE, device: 3, requestId: 9, offset: 0, length: 8, at: 0, bytes: new Uint8Array(new ArrayBuffer(16), 0, 4) });
  f.host.receive({ type: "frame-request", engine: ENGINE, device: 3 });
  f.host.receive({ type: "event", engine: ENGINE, device: 3, event: { type: 5, requestId: 0, handle: 0, status: 1, reason: 1, message: "lost" } });
  assert.equal(f.host.deviceGeneration, 4);
  assert.equal(f.host.pendingReadbacks, 0, "partial readback of the lost device is discarded");
  assert.equal(f.scheduled.size, 0, "frame request of the lost device is cancelled");
  assert.equal(f.host.receive({ type: "event", engine: ENGINE, device: 3, event: { type: 4, requestId: 2, status: 0 } }), false);
  assert.equal(f.host.receive({ type: "frame-request", engine: ENGINE, device: 3 }), false);
  assert.equal(f.host.receive({ type: "event", engine: ENGINE + 1, device: 4, event: { type: 4, requestId: 2, status: 0 } }), false, "other engine generation");
  assert.equal(f.host.receive({ type: "event", engine: ENGINE, device: 4, event: { type: 1, requestId: 3, status: 0 } }), true);
  await tick();
  assert.deepEqual(f.events.map((event) => event.type), [1, 5, 1]);
  assert.equal(f.host.stats.staleRejected, 3);
  assert.equal(f.host.failure, null);
});

test("dispose releases everything, suppresses queued deliveries and cancels the frame", async () => {
  const f = fixture();
  const a = f.arenas(16, 16);
  f.host.apply(a.batch, a.uploads, a.readbacks);
  f.host.receive({ type: "frame-request", engine: ENGINE, device: 0 });
  f.host.receive({ type: "event", engine: ENGINE, device: 0, event: { type: 4, requestId: 1, status: 0 } });
  f.host.receive({ type: "readback", engine: ENGINE, device: 0, requestId: 2, offset: 0, length: 8, at: 0, bytes: new Uint8Array(new ArrayBuffer(8), 0, 4) });
  f.host.dispose();
  f.host.dispose();
  assert.equal(f.scheduled.size, 0);
  assert.ok(f.schedulers.every((scheduler) => scheduler.disposed));
  assert.deepEqual(f.closed, [{ engine: ENGINE, reason: "disposed" }]);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.host.queue, { submissions: 0, bytes: 0, chunks: 0, unsent: 0, framesInFlight: 0, sentThrough: 0, ackedThrough: 0 });
  assert.equal(f.host.pendingReadbacks, 0);
  assert.equal(f.host.apply(a.batch, a.uploads, a.readbacks), false, "matches the JS host after disposal");
  assert.equal(f.host.receive({ type: "ack", engine: ENGINE, sequence: 1 }), false);
  assert.throws(() => f.host.setFrameMode("throughput"), /disposed/);
  await tick();
  assert.equal(f.events.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.failures.length, 0);
});

test("unexpected errors fail the generation closed without throwing into the bridge", async () => {
  const sendFails = fixture();
  sendFails.transport.send = () => { throw new Error("bridge gone"); };
  const a = sendFails.arenas(16);
  sendFails.host.apply(a.batch, a.uploads, a.readbacks);
  await tick();
  assert.equal(sendFails.host.failure.code, "transport-failed");
  assert.equal(sendFails.failures[0].code, "transport-failed");
  assert.throws(() => sendFails.host.apply(a.batch, a.uploads, a.readbacks), /bridge gone/);

  const callbackFails = fixture({ options: { onEvent: () => { throw new Error("observer"); } } });
  callbackFails.host.receive({ type: "event", engine: ENGINE, device: 0, event: { type: 4, requestId: 1, status: 0 } });
  await tick();
  assert.equal(callbackFails.host.failure.code, "event-callback-failed");

  for (const message of [null, { type: "nope", engine: ENGINE }, { type: "event", engine: ENGINE, device: 0, event: { type: 42, status: 0 } }]) {
    const f = fixture();
    assert.equal(f.host.receive(message), false);
    assert.equal(f.host.failure.code, "protocol-violation");
  }
  const executor = fixture();
  executor.host.receive({ type: "failed", engine: ENGINE, message: "decoder crashed" });
  assert.equal(executor.host.failure.code, "executor-failed");

  const scheduler = fixture({ options: { createScheduler: () => ({ request() { throw new Error("no display link"); }, cancel() {}, dispose() {} }) } });
  scheduler.host.receive({ type: "frame-request", engine: ENGINE, device: 0 });
  assert.equal(scheduler.host.failure.code, "scheduler-failed");

  const timeout = fixture();
  const b = timeout.arenas(16);
  timeout.host.apply(b.batch, b.uploads, b.readbacks);
  const [timer] = timeout.timers.values();
  assert.equal(timer.ms, 30000);
  timer.fn();
  assert.equal(timeout.host.failure.code, "ack-timeout");

  const frameThrows = fixture({ onFrame: () => { throw new Error("frame export trapped"); } });
  frameThrows.host.receive({ type: "frame-request", engine: ENGINE, device: 0 });
  frameThrows.fireFrame();
  await tick();
  assert.equal(frameThrows.host.failure, null, "matches the JS host: an onFrame error is reported as an ERROR event");
  assert.equal(frameThrows.events[0].type, 9);
});

test("foreign or oversized views are rejected like the JS host and nothing is queued", async () => {
  const f = fixture();
  const other = new Uint8Array(new ArrayBuffer(64));
  const a = f.arenas(16);
  assert.equal(f.host.apply(other, a.uploads, a.readbacks), false);
  await tick();
  assert.equal(f.events[0].type, 9); assert.match(f.events[0].message, /share reactor memory/);
  assert.equal(f.host.queue.submissions, 0);
  assert.equal(f.host.failure, null);
});

test("frame mode changes replace the scheduler and are ordered with submissions", async () => {
  const f = fixture();
  const a = f.arenas(16);
  f.host.receive({ type: "frame-request", engine: ENGINE, device: 0 });
  f.host.apply(a.batch, a.uploads, a.readbacks);
  f.host.setFrameMode("throughput");
  assert.equal(f.host.frameMode, "throughput");
  assert.equal(f.schedulers[0].disposed, true);
  assert.equal(f.schedulers[1].mode, "throughput");
  assert.equal(f.scheduled.size, 1, "an outstanding request moves to the new scheduler");
  assert.throws(() => f.host.setFrameMode("vsync"), /invalid frame mode/);
  await tick();
  assert.deepEqual(f.sent.map(({ message }) => message.kind), ["open", "submit", "chunk", "frame-mode"]);
  assert.equal(f.sent.at(-1).message.mode, "throughput");
});

test("a synchronous loopback acknowledgement inside send is accepted", async () => {
  const f = fixture();
  f.transport.onSend = (message) => { if (message.last) f.host.receive({ type: "ack", engine: ENGINE, sequence: message.sequence }); };
  const a = f.arenas(16, 8);
  f.host.apply(a.batch, a.uploads, a.readbacks);
  await tick();
  assert.equal(f.host.failure, null);
  assert.equal(f.host.queue.submissions, 0);
  assert.equal(f.host.stats.acknowledged, 1);
});
