import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNativeGpuHost } from "./native-gpu.js";
import {
  createNativeGpuWire, createWireParser, encodeWireFrame, readWireHeader, writeWireHeader, reportNativeGeometry,
  WIRE, WIRE_CHUNK_RESERVE, WIRE_FLAG_LAST, WIRE_HEADER_BYTES, WIRE_MAGIC,
} from "./native-gpu-wire.js";

// A fake native endpoint behind `fetch`: it parses upstream bodies with the wire codec, reassembles submissions
// and answers long-polls with frames the test queues. No WebKit, no executor: this checks the JavaScript half.
const SESSION = "a".repeat(64);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeNative({ holdPosts = false } = {}) {
  const posts = [], held = [], polls = [], submissions = [], frames = [];
  let current = null;
  const respond = (status, bytes = new Uint8Array(0)) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes.slice().buffer, text: async () => "" });
  const consume = (body) => {
    for (let at = 0; at < body.byteLength;) {
      const header = readWireHeader(body, at);
      assert.ok(header, "frame magic");
      const payload = body.subarray(at + WIRE_HEADER_BYTES, at + WIRE_HEADER_BYTES + header.payloadBytes);
      frames.push(header);
      if (header.kind === WIRE.SUBMIT) {
        current = { sequence: header.sequence, commandBytes: header.a, uploadBytes: header.b, commands: new Uint8Array(header.a), uploads: new Uint8Array(header.b) };
        submissions.push(current);
      } else if (header.kind === WIRE.CHUNK) {
        assert.equal(header.sequence, current.sequence);
        (header.c === 0 ? current.commands : current.uploads).set(payload, header.b);
        if (header.flags & WIRE_FLAG_LAST) current.done = true;
      }
      at += (WIRE_HEADER_BYTES + header.payloadBytes + 3) & ~3;
    }
  };
  const fetch = (url, init = {}) => {
    const parsed = new URL(url, "app://local/");
    assert.equal(init.headers?.["X-NT-GPU-Session"], SESSION);
    if (parsed.pathname.endsWith("/post")) {
      const body = init.body instanceof Uint8Array ? init.body : new Uint8Array(init.body);
      posts.push({ b: parsed.searchParams.get("b"), body });
      if (parsed.searchParams.get("b") !== "close") consume(body);
      if (holdPosts) return new Promise((resolve) => held.push(() => resolve(respond(204))));
      return Promise.resolve(respond(204));
    }
    return new Promise((resolve, reject) => {
      const poll = { resolve: (bytes) => resolve(respond(200, bytes)), refuse: (status) => resolve(respond(status)), aborted: false };
      init.signal?.addEventListener("abort", () => { poll.aborted = true; reject(new DOMException("aborted", "AbortError")); });
      polls.push(poll);
    });
  };
  const answer = (...parts) => {
    const poll = polls.shift();
    assert.ok(poll, "a poll is outstanding");
    const total = parts.reduce((n, p) => n + p.byteLength, 0), bytes = new Uint8Array(total);
    let at = 0; for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
    poll.resolve(bytes);
  };
  return { fetch, posts, held, polls, submissions, frames, answer };
}

function harness(engine = 3, native = fakeNative(), options = {}) {
  const memory = new ArrayBuffer(16 << 20);
  const events = [], failures = [], frames = [];
  const wire = createNativeGpuWire({ endpoint: "app://local/__ntgpu/", session: SESSION, engine, fetch: native.fetch, ...options });
  let host;
  host = createNativeGpuHost({
    transport: wire.connect({ receive: (m) => host.receive(m), resume: () => host.resume(), fail: (e) => failures.push(e) }),
    getMemory: () => memory, engineGeneration: engine, chunkHeaderBytes: WIRE_CHUNK_RESERVE, chunkBytes: 1 << 20,
    createScheduler: (mode) => wire.createScheduler(mode),
    onEvent: (event) => events.push(event), onFailure: (error) => failures.push(error), onFrame: (time) => frames.push(time),
  });
  const view = (at, length, seed) => { const v = new Uint8Array(memory, at, length); for (let i = 0; i < length; i++) v[i] = (i * 7 + seed) & 255; return v; };
  const apply = (commands, uploads = 0, seed = 1) => host.apply(view(0, commands, seed), view(4 << 20, uploads, seed + 1), new Uint8Array(memory, 15 << 20, 64));
  return { memory, wire, host, native, events, failures, frames, view, apply };
}

test("header layout mirrors hosts/macos/NativeGPUWire.swift", () => {
  const swift = readFileSync(new URL("../hosts/macos/NativeGPUWire.swift", import.meta.url), "utf8");
  assert.match(swift, new RegExp(`magic: UInt32 = 0x${WIRE_MAGIC.toString(16).replace(/(....)$/, "_$1")}`, "i"));
  assert.match(swift, new RegExp(`headerBytes = ${WIRE_HEADER_BYTES}\\b`));
  for (const [name, value] of Object.entries({ open: WIRE.OPEN, submit: WIRE.SUBMIT, chunk: WIRE.CHUNK, frameMode: WIRE.FRAME_MODE, tickRequest: WIRE.TICK_REQUEST,
    tickCancel: WIRE.TICK_CANCEL, close: WIRE.CLOSE, ack: WIRE.ACK, event: WIRE.EVENT, readback: WIRE.READBACK, frameRequest: WIRE.FRAME_REQUEST, failed: WIRE.FAILED, tick: WIRE.TICK })) {
    assert.match(swift, new RegExp(`\\b${name} = ${value}\\b`), name);
  }
  const frame = encodeWireFrame(WIRE.SUBMIT, { engine: 9, sequence: 4, a: 1, b: 2, c: 3, payload: new Uint8Array([1, 2, 3]) });
  assert.equal(frame.byteLength, 36);
  assert.deepEqual(readWireHeader(frame), { kind: WIRE.SUBMIT, flags: 0, engine: 9, sequence: 4, a: 1, b: 2, c: 3, payloadBytes: 3 });
});

test("parser reassembles frames split and merged across arbitrary chunk boundaries and bounds frame size", () => {
  const seen = [];
  const parser = createWireParser({ onFrame: (h, p) => seen.push([h.kind, [...p]]) });
  const a = encodeWireFrame(WIRE.ACK, { sequence: 1 }), b = encodeWireFrame(WIRE.EVENT, { payload: new Uint8Array([7, 8, 9, 10, 11]) });
  const all = new Uint8Array([...a, ...b]);
  for (const cut of [1, 31, 33, 40, 50]) { seen.length = 0; parser.push(all.subarray(0, cut)); parser.push(all.subarray(cut)); assert.deepEqual(seen, [[WIRE.ACK, []], [WIRE.EVENT, [7, 8, 9, 10, 11]]]); }
  const bad = encodeWireFrame(WIRE.ACK); bad[0] ^= 1;
  assert.throws(() => createWireParser({ onFrame() {} }).push(bad), /magic/);
  const huge = new Uint8Array(32); writeWireHeader(huge, 0, WIRE.READBACK, 0, 1, 0, 0, 0, 0, 64 << 20);
  assert.throws(() => createWireParser({ onFrame() {} }).push(huge), /exceeds bound/);
});

test("chunks travel as their own bodies with headers in the reserved prefix (no transport copy) and reassemble exactly", async () => {
  const { native, apply, wire, failures } = harness();
  assert.equal(apply(100, (2 << 20) + 5, 3), true);
  await tick();
  const submission = native.submissions[0];
  assert.ok(submission.done);
  // Every chunk body is a view into the chunk's own allocation: the frame header (and any pending control frames)
  // sit in the reserved bytes immediately before the payload, so the body ends exactly at the allocation's end.
  const kinds = (body) => { const out = []; for (let at = 0; at < body.byteLength;) { const h = readWireHeader(body, at); out.push(h.kind); at += (WIRE_HEADER_BYTES + h.payloadBytes + 3) & ~3; } return out; };
  const chunkPosts = native.posts.filter((p) => p.b !== "close" && kinds(p.body).includes(WIRE.CHUNK));
  assert.equal(chunkPosts.length, 4);
  for (const post of chunkPosts) {
    assert.equal(post.body.byteOffset + post.body.byteLength, post.body.buffer.byteLength);
    assert.ok(post.body.byteOffset < WIRE_CHUNK_RESERVE);
  }
  assert.deepEqual(readWireHeader(chunkPosts[0].body).kind, WIRE.OPEN, "open + submit rode in front of the first chunk");
  assert.equal(wire.stats.copiedChunks, 0);
  assert.equal(wire.stats.zeroCopyChunks, 4); // 1 command chunk + 3 upload chunks of 1 MiB
  for (let i = 0; i < 100; i++) assert.equal(submission.commands[i], (i * 7 + 3) & 255);
  for (let i = 0; i < submission.uploads.length; i += 4097) assert.equal(submission.uploads[i], (i * 7 + 4) & 255);
  assert.equal(native.frames[0].kind, WIRE.OPEN);
  assert.equal(failures.length, 0);
});

test("at most maxInflight bodies are outstanding; refusal resumes in order when a body completes", async () => {
  const native = fakeNative({ holdPosts: true });
  const { apply, host, wire } = harness(3, native, { maxInflight: 2 });
  apply(64, (3 << 20), 1);
  await tick();
  assert.equal(wire.inflight, 2);
  assert.ok(host.queue.unsent > 0, "host keeps refused messages");
  while (native.held.length) { native.held.shift()(); await tick(); await tick(); }
  assert.equal(host.queue.unsent, 0);
  assert.ok(native.submissions[0].done);
  assert.deepEqual(native.posts.filter((p) => p.b !== "close").map((p) => Number(p.b)), native.posts.map((_, i) => i + 1));
});

test("downstream long-poll delivers acks, events, chunked readbacks and frame ticks; re-polls after each answer", async () => {
  const { native, apply, host, events, frames, failures } = harness(5);
  apply(64, 16, 1);
  await tick();
  assert.equal(native.polls.length, 1);
  const json = (value) => new TextEncoder().encode(JSON.stringify(value));
  const prefix = (length, at, bytes) => { const p = new Uint8Array(8 + bytes.length); const v = new DataView(p.buffer); v.setUint32(0, length, true); v.setUint32(4, at, true); p.set(bytes, 8); return p; };
  native.answer(
    encodeWireFrame(WIRE.READBACK, { engine: 5, a: 0, b: 77, c: 32, payload: prefix(6, 0, [1, 2, 3]) }),
    encodeWireFrame(WIRE.READBACK, { engine: 5, a: 0, b: 77, c: 32, payload: prefix(6, 3, [4, 5, 6]) }),
    encodeWireFrame(WIRE.EVENT, { engine: 5, a: 0, payload: json({ type: 3, requestId: 77, handle: 0, status: 0, offset: 32, length: 6 }) }),
    encodeWireFrame(WIRE.ACK, { engine: 5, sequence: 1 }),
  );
  await tick(); await tick();
  assert.equal(host.queue.ackedThrough, 1);
  assert.deepEqual([...events[0].data], [1, 2, 3, 4, 5, 6]);
  assert.equal(native.polls.length, 1, "re-polled");
  // Executor frame request → scheduler tick request upstream → native tick → frame callback.
  native.answer(encodeWireFrame(WIRE.FRAME_REQUEST, { engine: 5, a: 0 }));
  await tick(); await tick();
  const request = native.frames.find((f) => f.kind === WIRE.TICK_REQUEST);
  assert.ok(request, "tick requested upstream");
  native.answer(encodeWireFrame(WIRE.TICK, { engine: 5, a: request.a }));
  await tick(); await tick();
  assert.equal(frames.length, 1);
  assert.equal(failures.length, 0);
});

test("an empty poll answer or a refused poll fails the generation; close aborts the poll and posts CLOSE", async () => {
  const one = harness(6);
  await tick();
  one.native.answer();
  await tick(); await tick();
  assert.match(one.failures[0]?.message ?? "", /closed by host/);
  const two = harness(7);
  await tick();
  two.native.polls[0].refuse(410);
  await tick(); await tick();
  assert.match(two.failures[0]?.message ?? "", /HTTP 410/);
  const three = harness(8);
  await tick();
  const poll = three.native.polls[0];
  three.host.dispose();
  await tick();
  assert.equal(poll.aborted, true);
  const close = three.native.posts.find((p) => p.b === "close");
  assert.equal(readWireHeader(close.body).kind, WIRE.CLOSE);
  assert.equal(three.failures.length, 0);
});

test("frames for another engine generation are ignored", async () => {
  const { native, host, wire } = harness(9);
  await tick();
  native.answer(encodeWireFrame(WIRE.ACK, { engine: 8, sequence: 1 }), encodeWireFrame(WIRE.FRAME_REQUEST, { engine: 10, a: 0 }));
  await tick(); await tick();
  assert.equal(wire.stats.staleFrames, 2);
  assert.equal(host.failure, null);
});

test("geometry reporter posts on layout changes only, deduplicated, and stops on dispose", async () => {
  const listeners = new Map(), observers = [];
  let rect = { x: 10, y: 20, width: 300, height: 150 };
  class Observer { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.fn = null; } }
  const scope = {
    devicePixelRatio: 2, ResizeObserver: Observer, MutationObserver: Observer,
    document: { visibilityState: "visible", documentElement: {}, body: {}, addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: (fn) => { queueMicrotask(fn); return 1; }, cancelAnimationFrame() {},
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name),
    getComputedStyle: () => ({ opacity: "1", filter: "none", mixBlendMode: "normal", visibility: "visible", display: "block" }),
  };
  const posts = [];
  const reporter = reportNativeGeometry(scope, { getBoundingClientRect: () => rect }, (r) => posts.push(r));
  await tick();
  assert.equal(posts.length, 1);
  observers[1].fn(); await tick();
  assert.equal(posts.length, 1, "unchanged layout is not re-posted");
  rect = { ...rect, y: 128 };
  observers[1].fn(); await tick();
  assert.deepEqual([posts[1].y, posts[1].revision], [128, 2]);
  reporter.dispose();
  assert.equal(listeners.size, 0);
});
