import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createGpuHost, GpuHandles } from "./host.js";
import { decodeGpuBatch } from "./gpu-host.generated.js";

const spec = JSON.parse(readFileSync(new URL("./ops.json", import.meta.url)));
const camel = (name) => name.toLowerCase().replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
function batch(operations) {
  const chunks = [];
  const expected = [];
  const scalar = (type, value) => {
    const bytes = Buffer.alloc(type === "f64" ? 8 : type === "bool" ? 1 : 4);
    if (type === "f64") bytes.writeDoubleLE(value);
    else if (type === "f32") bytes.writeFloatLE(value);
    else if (type === "i32") bytes.writeInt32LE(value);
    else if (type === "bool") bytes[0] = value ? 1 : 0;
    else bytes.writeUInt32LE(value >>> 0);
    chunks.push(bytes);
  };
  for (const { op, values } of operations) {
    chunks.push(Buffer.from([op.code]));
    if (op.result) scalar("u32", values[0]);
    let index = op.result ? 1 : 0;
    for (const arg of op.args) {
      const type = arg.split(":")[1], value = values[index++];
      if (type === "str") { const b = Buffer.from(value); scalar("u32", b.length); chunks.push(b); }
      else if (type.endsWith("[]")) { scalar("u32", value.length); for (const item of value) scalar(type === "f64[]" ? "f64" : "u32", item); }
      else if (type === "upload" || type === "readback") { scalar("u32", value.offset); scalar("u32", value.length); }
      else scalar(type, value);
    }
    expected.push([camel(op.name), values]);
  }
  return { bytes: Buffer.concat(chunks), expected };
}
const op = (name) => spec.ops.find((entry) => entry.name === name);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((done) => setImmediate(done));

// These unit fixtures test protocol semantics; browser-test.mjs tests the real GPU.
function fixture() {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const events = [], writes = [], frames = [];
  const lost = deferred();
  const submitted = deferred();
  const device = {
    features: new Set(["timestamp-query"]), limits: { maxBufferSize: 268435456 },
    queue: {
      writeBuffer: (...args) => writes.push(args),
      writeTexture: (...args) => writes.push(args),
      onSubmittedWorkDone: () => submitted.promise,
    },
    addEventListener() {}, lost: lost.promise, destroy() {},
  };
  const adapter = { features: new Set(["timestamp-query"]), requestDevice: async () => device };
  const canvas = { width: 100, height: 100, clientWidth: 100, clientHeight: 100 };
  const host = createGpuHost({ canvas, gpu: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => "bgra8unorm" }, scope: {}, getMemory: () => memory.buffer, onEvent: (event) => events.push(event), requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {} });
  const apply = (bytes, uploadOffset = 16384, uploadLength = 16384, readbackOffset = 32768, readbackLength = 16384) => {
    new Uint8Array(memory.buffer, 0, bytes.length).set(bytes);
    return host.apply(new Uint8Array(memory.buffer, 0, bytes.length), new Uint8Array(memory.buffer, uploadOffset, uploadLength), new Uint8Array(memory.buffer, readbackOffset, readbackLength));
  };
  return { memory, events, writes, frames, lost, submitted, device, host, apply };
}
async function connected() {
  const f = fixture();
  f.host.requestDevice(1, 1, 1, 0);
  await tick();
  assert.equal(f.host.device, f.device);
  return f;
}

test("GPU generated files do not drift", () => {
  execFileSync(process.execPath, [new URL("./generate.mjs", import.meta.url).pathname, "--check"]);
});

test("all schema operations decode with exact operands and UTF-8", () => {
  const calls = [], errors = [];
  const host = { protocolError: (error) => errors.push(error) };
  const operations = spec.ops.map((op) => {
    host[camel(op.name)] = (...values) => calls.push([camel(op.name), values]);
    const values = op.result ? [1048577] : [];
    for (const arg of op.args) {
      const type = arg.split(":")[1];
      values.push(type === "str" ? "label café 🌍" : type === "bool" ? true : type.endsWith("[]") ? [1, 2, 3] : type === "upload" || type === "readback" ? { offset: 128, length: 64, readback: type === "readback" } : type === "i32" ? -3 : type === "f32" || type === "f64" ? 1.5 : 7);
    }
    return { op, values };
  });
  const encoded = batch(operations);
  assert.equal(decodeGpuBatch(host, encoded.bytes), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, encoded.expected);
});

test("truncation, oversized arrays and unknown opcodes fail closed", () => {
  const errors = [];
  const host = { protocolError: (error) => errors.push(error), queueSubmit() { assert.fail("malformed submission dispatched"); } };
  assert.equal(decodeGpuBatch(host, Buffer.from([255])), false);
  assert.equal(decodeGpuBatch(host, Buffer.from([39, 1, 0])), false);
  assert.equal(decodeGpuBatch(host, Buffer.from([39, 1, 0, 1, 0])), false);
  assert.equal(errors.length, 3);
});

test("stale and wrong-type handles are reported; generations do not wrap", async () => {
  const f = await connected();
  const h = f.host.handles;
  h.reserve(1048577, "buffer", {});
  h.retire(1048577);
  h.reserve(2097153, "buffer", {});
  assert.throws(() => h.get(1048577), /stale/);
  assert.throws(() => h.get(2097153, "texture"), /expected/);
  const encoded = batch([{ op: op("WRITE_BUFFER"), values: [1048577, 0, { offset: 0, length: 4 }] }]);
  assert.equal(f.apply(encoded.bytes), false);
  await tick();
  assert.match(f.events.at(-1).message, /stale/);
  for (let generation = 2; generation <= 4095; generation++) {
    const handle = generation * 1048576 + 1;
    if (generation !== 2) h.reserve(handle, "buffer", {});
    h.retire(handle);
  }
  assert.throws(() => h.reserve(1048577, "buffer", {}), /stale/);
  f.host.dispose();
});

test("upload uses the current grown memory, not copied command bytes", async () => {
  const f = await connected();
  const resource = {};
  f.host.handles.reserve(1048577, "buffer", resource);
  const old = f.memory.buffer;
  f.memory.grow(4);
  assert.notEqual(f.memory.buffer, old);
  const upload = new Uint8Array(f.memory.buffer, 262144, 16);
  upload.fill(19);
  const encoded = batch([{ op: op("WRITE_BUFFER"), values: [1048577, 0, { offset: 0, length: 16 }] }]);
  assert.equal(f.apply(encoded.bytes, 262144, 16), true);
  assert.equal(f.writes[0][2], f.memory.buffer);
  assert.equal(f.writes[0][3], 262144);
  assert.equal(f.writes[0][4], 16);
  f.host.dispose();
});

test("async map reacquires memory after growth and unmaps before completion", async () => {
  const f = await connected();
  const mapped = deferred();
  let unmapped = false;
  const resource = { mapAsync: () => mapped.promise, getMappedRange: () => new Uint8Array([1, 2, 3, 4]).buffer, unmap: () => { unmapped = true; } };
  f.host.handles.reserve(1048577, "buffer", resource);
  const encoded = batch([{ op: op("MAP_ASYNC"), values: [2, 1048577, 1, 0, 4, { offset: 0, length: 4 }] }]);
  assert.equal(f.apply(encoded.bytes), true);
  await tick();
  f.memory.grow(1);
  mapped.resolve();
  await tick();
  assert.deepEqual([...new Uint8Array(f.memory.buffer, 32768, 4)], [1, 2, 3, 4]);
  assert.equal(unmapped, true);
  assert.equal(f.events.at(-1).type, 3);
  f.host.dispose();
});

test("device lost cancels scheduling and suppresses late completions", async () => {
  const f = await connected();
  f.host.requestFrame();
  f.host.onSubmittedWorkDone(3);
  await tick();
  f.lost.resolve({ reason: "destroyed", message: "test loss" });
  await tick();
  assert.equal(f.host.device, null);
  assert.equal(f.host.idle, true);
  assert.equal(f.events.at(-1).type, 5);
  f.submitted.resolve();
  await tick();
  assert.equal(f.events.filter((event) => event.type === 4).length, 0);
  f.host.dispose();
});

test("zero callbacks while idle; requests coalesce and never repeat themselves", async () => {
  const f = await connected();
  await tick();
  assert.equal(f.frames.length, 0);
  f.host.requestFrame(); f.host.requestFrame();
  assert.equal(f.frames.length, 1);
  f.frames[0](10);
  assert.equal(f.host.stats.frames, 1);
  await tick();
  assert.equal(f.frames.length, 1);
  assert.equal(f.host.idle, true);
  f.host.dispose();
});

test("absent WebGPU is a capability event", async () => {
  const events = [];
  const host = createGpuHost({ scope: {}, canvas: {}, getMemory: () => new ArrayBuffer(0), onEvent: (event) => events.push(event) });
  host.requestDevice(1, 0, 0, 0);
  await tick();
  assert.equal(events[0].type, 1);
  assert.equal(events[0].available, false);
  host.dispose();
});
