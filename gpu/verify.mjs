import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createGpuHost, GpuHandles } from "./host.js";
import * as generated from "./gpu-host.generated.js";

const { decodeGpuBatch, GPU_PROTOCOL_IDENTITY, GPU_PROTOCOL_VERSION, GPU_PROTOCOL_HEADER_BYTES } = generated;
const source = readFileSync(new URL("./ops.json", import.meta.url), "utf8");
const spec = JSON.parse(source);
const camel = (name) => name.toLowerCase().replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const C = generated;
const E = { CAPABILITIES: 1, PIPELINE_READY: 2, MAP_READY: 3, WORK_DONE: 4, DEVICE_LOST: 5, SHADER_INFO: 7, ERROR: 9 };
const S = { OK: 0, ERROR: 1, CANCELLED: 2, LOST: 3 };
const h = (slot, generation = 1) => generation * 2 ** 20 + slot;

function headerBytes(version = GPU_PROTOCOL_VERSION, identity = GPU_PROTOCOL_IDENTITY) {
  const bytes = Buffer.alloc(GPU_PROTOCOL_HEADER_BYTES);
  bytes[0] = generated.GPU_PROTOCOL_OPCODE;
  bytes.writeUInt32LE(version, 1);
  bytes.writeUInt32LE(identity, 5);
  return bytes;
}
// Encodes [operationName, ...operands] tuples exactly as the generated guest functions do.
function batch(operations, header = headerBytes()) {
  const chunks = header ? [header] : [];
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
  for (const [name, ...values] of operations) {
    const op = spec.ops.find((entry) => camel(entry.name) === name);
    assert.ok(op && !op.header, `unknown operation ${name}`);
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
    assert.equal(index, values.length, `${name} operand count`);
    expected.push([name, values]);
  }
  return { bytes: Buffer.concat(chunks), expected };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((done) => setImmediate(done));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };

// These fixtures test protocol semantics with a recording WebGPU double; conformance.mjs runs the real GPU.
function mockDevice() {
  const log = [];
  const lost = deferred();
  const maps = [];
  const pipelines = [];
  let workDone = deferred();
  const recorder = (kind, descriptor, names) => {
    const object = { kind, descriptor, calls: [] };
    for (const name of names) object[name] = (...args) => { object.calls.push([name, ...args]); log.push([`${kind}.${name}`, ...args]); };
    return object;
  };
  const passNames = ["setPipeline", "setBindGroup", "dispatchWorkgroups", "dispatchWorkgroupsIndirect", "end", "setViewport", "setScissorRect", "setVertexBuffer", "setIndexBuffer", "draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect", "setStencilReference", "setBlendConstant", "beginOcclusionQuery", "endOcclusionQuery"];
  const device = {
    features: new Set(["timestamp-query"]),
    limits: { maxBufferSize: 268435456, maxColorAttachments: 8, maxVertexBuffers: 8, maxVertexAttributes: 16, maxVertexBufferArrayStride: 2048 },
    queue: {
      writeBuffer: (...args) => log.push(["queue.writeBuffer", ...args]),
      writeTexture: (...args) => log.push(["queue.writeTexture", ...args]),
      submit: (list) => log.push(["queue.submit", list]),
      onSubmittedWorkDone: () => workDone.promise,
    },
    createBuffer: (descriptor) => {
      const buffer = {
        kind: "buffer", descriptor, size: descriptor.size, usage: descriptor.usage, unmaps: 0, destroyed: false,
        mapAsync: (...args) => { const pending = deferred(); maps.push({ buffer, args, ...pending }); return pending.promise; },
        getMappedRange: (offset, size) => new Uint8Array(size).map((_value, i) => i + 1).buffer,
        unmap: () => { buffer.unmaps++; }, destroy: () => { buffer.destroyed = true; },
      };
      return buffer;
    },
    createTexture: (descriptor) => ({ kind: "texture", descriptor, createView: (view) => ({ kind: "textureView", descriptor: view }), destroy() {} }),
    createShaderModule: (descriptor) => ({ kind: "shaderModule", descriptor, getCompilationInfo: async () => ({ messages: [] }) }),
    createPipelineLayout: (descriptor) => ({ kind: "pipelineLayout", descriptor }),
    createBindGroupLayout: (descriptor) => ({ kind: "bindGroupLayout", descriptor }),
    createQuerySet: (descriptor) => ({ kind: "querySet", descriptor, destroy() {} }),
    createComputePipeline: (descriptor) => ({ kind: "computePipeline", descriptor }),
    createRenderPipeline: (descriptor) => ({ kind: "renderPipeline", descriptor }),
    createComputePipelineAsync: (descriptor) => { const pending = deferred(); pipelines.push({ descriptor, ...pending }); return pending.promise; },
    createRenderPipelineAsync: (descriptor) => { const pending = deferred(); pipelines.push({ descriptor, ...pending }); return pending.promise; },
    createCommandEncoder: (descriptor) => {
      const encoder = recorder("encoder", descriptor, ["copyBufferToBuffer", "copyBufferToTexture", "copyTextureToBuffer", "copyTextureToTexture", "clearBuffer", "resolveQuerySet"]);
      encoder.beginComputePass = (pass) => recorder("computePass", pass, passNames);
      encoder.beginRenderPass = (pass) => recorder("renderPass", pass, passNames);
      encoder.finish = (finish) => ({ kind: "commandBuffer", descriptor: finish });
      return encoder;
    },
    addEventListener() {}, lost: lost.promise, destroyed: false, destroy() { this.destroyed = true; },
  };
  return { device, log, lost, maps, pipelines, resolveWork: () => { workDone.resolve(); workDone = deferred(); } };
}

function fixture({ adapterFeatures = ["timestamp-query"], adapterLimits = { maxBufferSize: 268435456, maxStorageBuffersPerShaderStage: 10, minUniformBufferOffsetAlignment: 256, maxColorAttachments: 8 }, onEvent = () => {} } = {}) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const events = [], frames = [];
  let mock = mockDevice();
  const requested = [];
  // Every device request yields a fresh device, as WebGPU does after a loss.
  const adapter = { features: new Set(adapterFeatures), limits: adapterLimits, requestDevice: async (descriptor) => { if (requested.length) mock = mockDevice(); requested.push(descriptor); return mock.device; } };
  const canvas = { width: 100, height: 100, clientWidth: 100, clientHeight: 100 };
  const host = createGpuHost({ canvas, gpu: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => "bgra8unorm" }, scope: {}, getMemory: () => memory.buffer, onEvent: (event) => { events.push(event); onEvent(event); }, requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {} });
  const apply = (operations, { uploadOffset = 16384, uploadLength = 16384, readbackOffset = 32768, readbackLength = 16384, header } = {}) => {
    const bytes = Array.isArray(operations) ? batch(operations, header).bytes : operations;
    new Uint8Array(memory.buffer, 0, bytes.length).set(bytes);
    return host.apply(new Uint8Array(memory.buffer, 0, bytes.length), new Uint8Array(memory.buffer, uploadOffset, uploadLength), new Uint8Array(memory.buffer, readbackOffset, readbackLength));
  };
  const terminal = (id) => events.filter((event) => event.requestId === id && generated.GPU_TERMINAL_EVENTS.has(event.type));
  return { memory, events, frames, get mock() { return mock; }, requested, adapter, host, apply, terminal };
}
async function connected(options) {
  const f = fixture(options);
  assert.equal(f.apply([["requestDevice", 1, 1, 1, 0]]), true);
  await settle();
  assert.equal(f.host.device, f.mock.device);
  return f;
}
const errorsOf = (f) => f.events.filter((event) => event.type === E.ERROR);

test("GPU generated files do not drift", () => {
  execFileSync(process.execPath, [new URL("./generate.mjs", import.meta.url).pathname, "--check"]);
});

test("protocol identity is generated from the schema for guest and host", () => {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(JSON.stringify(JSON.parse(source)), "utf8")) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  assert.equal(GPU_PROTOCOL_IDENTITY, hash >>> 0);
  const guestLimits = readFileSync(new URL("./limits.generated.ts", import.meta.url), "utf8");
  assert.match(guestLimits, new RegExp(`PROTOCOL_IDENTITY = 0x${GPU_PROTOCOL_IDENTITY.toString(16).padStart(8, "0")};`));
  assert.match(guestLimits, new RegExp(`PROTOCOL_VERSION = ${GPU_PROTOCOL_VERSION};`));
  const written = new Uint8Array(GPU_PROTOCOL_HEADER_BYTES);
  generated.writeGpuProtocolHeader(written);
  assert.deepEqual([...written], [...headerBytes()]);
});

test("batches without the exact protocol header are refused before any operation", async () => {
  const f = await connected();
  const scissor = [["createBuffer", h(9), 64, C.BUFFER_USAGE_COPY_DST, false, "never"]];
  for (const header of [null, headerBytes(GPU_PROTOCOL_VERSION + 1), headerBytes(GPU_PROTOCOL_VERSION, (GPU_PROTOCOL_IDENTITY ^ 1) >>> 0)]) {
    assert.equal(f.apply(scissor, { header }), false);
  }
  await settle();
  const errors = errorsOf(f);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((event) => event.fatal === true && event.requestId === 0));
  assert.match(errors[1].message, /identity mismatch/);
  assert.equal(f.host.handles.peek(h(9)), null);
  f.host.dispose();
});

test("all schema operations decode with exact operands and UTF-8", () => {
  const calls = [], errors = [];
  const host = { protocolError: (error) => errors.push(error) };
  const operations = spec.ops.filter((op) => !op.header).map((op) => {
    host[camel(op.name)] = (...values) => calls.push([camel(op.name), values]);
    const values = op.result ? [1048577] : [];
    for (const arg of op.args) {
      const type = arg.split(":")[1];
      values.push(type === "str" ? "label café 🌍" : type === "bool" ? true : type.endsWith("[]") ? [1, 2, 3] : type === "upload" || type === "readback" ? { offset: 128, length: 64, readback: type === "readback" } : type === "i32" ? -3 : type === "f32" || type === "f64" ? 1.5 : 7);
    }
    return [camel(op.name), ...values];
  });
  const encoded = batch(operations);
  assert.equal(decodeGpuBatch(host, encoded.bytes), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, encoded.expected);
});

test("truncation, oversized arrays and unknown opcodes fail closed", () => {
  const errors = [];
  const host = { protocolError: (error, _request, _handle, fatal) => errors.push(fatal), queueSubmit() { assert.fail("malformed submission dispatched"); } };
  const head = headerBytes();
  assert.equal(decodeGpuBatch(host, Buffer.concat([head, Buffer.from([255])])), false);
  assert.equal(decodeGpuBatch(host, Buffer.concat([head, Buffer.from([39, 1, 0])])), false);
  assert.equal(decodeGpuBatch(host, Buffer.concat([head, Buffer.from([39, 1, 0, 1, 0])])), false);
  assert.equal(decodeGpuBatch(host, Buffer.concat([head, Buffer.from([generated.GPU_PROTOCOL_OPCODE])])), false);
  assert.deepEqual(errors, [true, true, true, true]);
});

test("a rejected operation cancels later requests once, still retires handles and keeps frames", async () => {
  const f = await connected();
  assert.equal(f.apply([
    ["createBuffer", h(1), 16, C.BUFFER_USAGE_MAP_READ | C.BUFFER_USAGE_COPY_DST, false, "readback"],
    ["writeBuffer", h(77), 0, { offset: 0, length: 4 }],
    ["createBuffer", h(2), 16, C.BUFFER_USAGE_COPY_DST, false, "never created"],
    ["mapAsync", 5, h(1), C.MAP_MODE_READ, 0, 16, { offset: 0, length: 16 }],
    ["onSubmittedWorkDone", 6],
    ["destroy", h(1)],
    ["destroy", h(2)],
    ["requestFrame"],
  ]), false);
  await settle();
  const errors = errorsOf(f);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /stale/);
  assert.notEqual(errors[0].fatal, true);
  assert.deepEqual(f.terminal(5).map((event) => [event.type, event.status]), [[E.MAP_READY, S.CANCELLED]]);
  assert.deepEqual(f.terminal(6).map((event) => [event.type, event.status]), [[E.WORK_DONE, S.CANCELLED]]);
  assert.equal(f.mock.maps.length, 0);
  assert.equal(f.frames.length, 1);
  // Both slots advanced to generation 2 on the host, exactly as the guest allocator did.
  f.host.handles.reserve(h(1, 2), "buffer", {});
  f.host.handles.reserve(h(2, 2), "buffer", {});
  assert.equal(f.host.pendingRequests, 0);
  f.host.dispose();
});

test("stale and wrong-type handles are reported; generations do not wrap", async () => {
  const f = await connected();
  const handles = f.host.handles;
  handles.reserve(h(1), "buffer", {});
  handles.retire(h(1));
  handles.reserve(h(1, 2), "buffer", {});
  assert.throws(() => handles.get(h(1)), /stale/);
  assert.throws(() => handles.get(h(1, 2), "texture"), /expected/);
  assert.throws(() => handles.retire(h(1)), /stale/);
  assert.equal(f.apply([["writeBuffer", h(1), 0, { offset: 0, length: 4 }]]), false);
  await settle();
  assert.match(f.events.at(-1).message, /stale/);
  for (let generation = 2; generation <= 4095; generation++) {
    if (generation !== 2) handles.reserve(h(1, generation), "buffer", {});
    handles.retire(h(1, generation));
  }
  assert.throws(() => handles.reserve(h(1), "buffer", {}), /stale/);
  f.host.dispose();
});

test("a failed creation stays allocated until the guest retires it", async () => {
  const f = await connected();
  f.mock.device.createBuffer = () => { throw new Error("out of memory"); };
  assert.equal(f.apply([["createBuffer", h(3), 64, C.BUFFER_USAGE_COPY_DST, false, "fails"]]), false);
  assert.throws(() => f.host.handles.get(h(3)), /creation failed/);
  assert.equal(f.apply([["destroy", h(3)]]), true);
  f.host.handles.reserve(h(3, 2), "buffer", {});
  f.host.dispose();
});

test("upload uses the current grown memory, not copied command bytes", async () => {
  const f = await connected();
  f.host.handles.reserve(h(1), "buffer", {});
  const old = f.memory.buffer;
  f.memory.grow(4);
  assert.notEqual(f.memory.buffer, old);
  new Uint8Array(f.memory.buffer, 262144, 16).fill(19);
  assert.equal(f.apply([["writeBuffer", h(1), 0, { offset: 0, length: 16 }]], { uploadOffset: 262144, uploadLength: 16 }), true);
  const write = f.mock.log.find((entry) => entry[0] === "queue.writeBuffer");
  assert.equal(write[3], f.memory.buffer);
  assert.equal(write[4], 262144);
  assert.equal(write[5], 16);
  assert.equal(f.apply([["writeBuffer", h(1), 2, { offset: 0, length: 16 }]], { uploadOffset: 262144, uploadLength: 16 }), false);
  assert.equal(f.apply([["writeBuffer", h(1), 0, { offset: 8, length: 16 }]], { uploadOffset: 262144, uploadLength: 16 }), false);
  f.host.dispose();
});

test("async map never mutates borrowed bytes, stages owned data after growth and unmaps before completion", async () => {
  const f = await connected();
  assert.equal(f.apply([
    ["createBuffer", h(1), 16, C.BUFFER_USAGE_MAP_READ | C.BUFFER_USAGE_COPY_DST, false, "readback"],
    ["mapAsync", 2, h(1), C.MAP_MODE_READ, 0, 4, { offset: 0, length: 4 }],
  ]), true);
  await settle();
  f.memory.grow(1);
  f.mock.maps[0].resolve();
  await settle();
  assert.deepEqual([...new Uint8Array(f.memory.buffer, 32768, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...f.terminal(2)[0].data], [1, 2, 3, 4]);
  assert.notEqual(f.terminal(2)[0].data.buffer, f.memory.buffer);
  assert.equal(f.mock.maps[0].buffer.unmaps, 1);
  assert.deepEqual(f.terminal(2).map((event) => [event.type, event.status, event.handle]), [[E.MAP_READY, S.OK, h(1)]]);
  f.host.dispose();
});

test("readback bounds, alignment and overlapping destinations are refused with the request id", async () => {
  const f = await connected();
  assert.equal(f.apply([["createBuffer", h(1), 64, C.BUFFER_USAGE_MAP_READ | C.BUFFER_USAGE_COPY_DST, false, "readback"], ["createBuffer", h(2), 64, C.BUFFER_USAGE_MAP_READ | C.BUFFER_USAGE_COPY_DST, false, "readback"]]), true);
  const cases = [
    [10, h(1), 4, 16, { offset: 0, length: 16 }, /multiple of 8/],
    [11, h(1), 0, 6, { offset: 0, length: 16 }, /multiple of 4/],
    [12, h(1), 0, 128, { offset: 0, length: 128 }, /outside buffer/],
    [13, h(1), 0, 32, { offset: 0, length: 16 }, /outside staging/],
    [14, h(1), 0, 16, { offset: 16380, length: 16 }, /outside staging/],
  ];
  for (const [id, buffer, offset, size, destination] of cases) assert.equal(f.apply([["mapAsync", id, buffer, C.MAP_MODE_READ, offset, size, destination]]), false);
  assert.equal(f.apply([["mapAsync", 20, h(1), C.MAP_MODE_READ, 0, 16, { offset: 0, length: 16 }]]), true);
  assert.equal(f.apply([["mapAsync", 21, h(2), C.MAP_MODE_READ, 0, 16, { offset: 8, length: 16 }]]), false);
  assert.equal(f.apply([["mapAsync", 22, h(1), C.MAP_MODE_READ, 0, 16, { offset: 64, length: 16 }]]), false);
  await settle();
  cases.forEach(([id, , , , , message]) => assert.match(f.terminal(id)[0].message, message));
  assert.match(f.terminal(21)[0].message, /in use by a pending request/);
  assert.match(f.terminal(22)[0].message, /pending map/);
  assert.equal(f.terminal(20).length, 0);
  f.host.dispose();
});

test("device loss completes every pending request once with LOST before DEVICE_LOST", async () => {
  const f = await connected();
  assert.equal(f.apply([
    ["createBuffer", h(1), 16, C.BUFFER_USAGE_MAP_READ | C.BUFFER_USAGE_COPY_DST, false, "readback"],
    ["createShaderModule", h(2), 40, "@compute @workgroup_size(1) fn main() {}", "shader"],
    ["createComputePipelineAsync", h(3), 41, 0, h(2), "main", "pipeline"],
    ["mapAsync", 42, h(1), C.MAP_MODE_READ, 0, 16, { offset: 0, length: 16 }],
    ["onSubmittedWorkDone", 43],
    ["requestFrame"],
  ]), true);
  await tick();
  const before = f.events.length;
  f.mock.lost.resolve({ reason: "unknown", message: "test loss" });
  await settle();
  const after = f.events.slice(before);
  assert.deepEqual(after.map((event) => [event.type, event.requestId, event.status]), [[E.PIPELINE_READY, 41, S.LOST], [E.MAP_READY, 42, S.LOST], [E.WORK_DONE, 43, S.LOST], [E.DEVICE_LOST, 0, S.ERROR]]);
  assert.equal(f.host.device, null);
  assert.equal(f.host.idle, true);
  // Late WebGPU completions are suppressed; lost handles reject use but accept retirement.
  f.mock.pipelines[0].resolve({ kind: "computePipeline" });
  f.mock.maps[0].resolve();
  f.mock.resolveWork();
  await settle();
  assert.equal(f.events.length, before + 4);
  assert.throws(() => f.host.handles.get(h(1)), /lost with its device/);
  assert.equal(f.apply([["destroy", h(1)], ["destroy", h(2)], ["release", h(3)]]), true);
  assert.equal(f.apply([["requestDevice", 44, 0, 0, 0]]), true);
  await settle();
  assert.equal(f.terminal(44)[0].status, S.OK);
  assert.equal(f.host.device, f.mock.device);
  assert.equal(f.apply([["createBuffer", h(1, 2), 16, C.BUFFER_USAGE_COPY_DST, false, "after restart"]]), true);
  assert.equal(f.events.filter((event) => event.type === E.ERROR).length, 0);
  f.host.dispose();
});

test("destroyDevice settles pending work synchronously and allows a restart", async () => {
  const f = await connected();
  assert.equal(f.apply([["onSubmittedWorkDone", 50], ["destroyDevice"], ["onSubmittedWorkDone", 51]]), false);
  assert.equal(f.mock.device.destroyed, true);
  await settle();
  assert.deepEqual(f.events.filter((event) => event.requestId >= 50 || event.type === E.DEVICE_LOST).map((event) => [event.type, event.requestId, event.status]), [[E.WORK_DONE, 50, S.LOST], [E.DEVICE_LOST, 0, S.ERROR], [E.ERROR, 51, S.ERROR]]);
  assert.match(f.terminal(51)[0].message, /device unavailable/);
  f.mock.lost.resolve({ reason: "destroyed", message: "late" });
  await settle();
  assert.equal(f.events.filter((event) => event.type === E.DEVICE_LOST).length, 1);
  f.host.dispose();
});

test("cancellation, unmap and destroy complete a pending map exactly once", async () => {
  const f = await connected();
  const make = (slot) => ["createBuffer", h(slot), 16, C.BUFFER_USAGE_MAP_READ | C.BUFFER_USAGE_COPY_DST, false, "readback"];
  assert.equal(f.apply([make(1), make(2), make(3),
    ["mapAsync", 60, h(1), C.MAP_MODE_READ, 0, 16, { offset: 0, length: 16 }], ["cancelRequest", 60], ["cancelRequest", 60], ["cancelRequest", 999],
    ["mapAsync", 61, h(2), C.MAP_MODE_READ, 0, 16, { offset: 16, length: 16 }], ["unmap", h(2)],
    ["mapAsync", 62, h(3), C.MAP_MODE_READ, 0, 16, { offset: 32, length: 16 }], ["destroy", h(3)],
    ["mapAsync", 63, h(1), C.MAP_MODE_READ, 0, 16, { offset: 0, length: 16 }],
  ]), true);
  await settle();
  for (const id of [60, 61, 62]) assert.deepEqual(f.terminal(id).map((event) => [event.type, event.status]), [[E.MAP_READY, S.CANCELLED]]);
  assert.equal(f.mock.maps[0].buffer.unmaps, 1);
  assert.equal(f.mock.maps[1].buffer.unmaps, 1);
  assert.equal(f.mock.maps[2].buffer.destroyed, true);
  for (const map of f.mock.maps.slice(0, 3)) map.reject(new Error("AbortError"));
  f.mock.maps[3].resolve();
  await settle();
  assert.deepEqual(f.terminal(63).map((event) => [event.type, event.status]), [[E.MAP_READY, S.OK]]);
  assert.equal(f.events.filter((event) => event.requestId >= 60 && event.requestId <= 62).length, 3);
  assert.equal(errorsOf(f).length, 0);
  f.host.dispose();
});

test("cancelled or released async pipelines complete once and stay unusable", async () => {
  const f = await connected();
  assert.equal(f.apply([
    ["createShaderModule", h(1), 70, "@compute @workgroup_size(1) fn main() {}", "shader"],
    ["createComputePipelineAsync", h(2), 71, 0, h(1), "main", "cancelled"], ["cancelRequest", 71],
    ["createComputePipelineAsync", h(3), 72, 0, h(1), "main", "released"], ["release", h(3)],
    ["createComputePipelineAsync", h(4), 73, 0, h(1), "main", "ready"],
  ]), true);
  await settle();
  for (const pipeline of f.mock.pipelines) pipeline.resolve({ kind: "computePipeline" });
  await settle();
  assert.deepEqual(f.terminal(71).map((event) => [event.type, event.status, event.handle]), [[E.PIPELINE_READY, S.CANCELLED, h(2)]]);
  assert.deepEqual(f.terminal(72).map((event) => [event.type, event.status]), [[E.PIPELINE_READY, S.CANCELLED]]);
  assert.deepEqual(f.terminal(73).map((event) => [event.type, event.status]), [[E.PIPELINE_READY, S.OK]]);
  assert.deepEqual(f.terminal(70).map((event) => [event.type, event.status]), [[E.SHADER_INFO, S.OK]]);
  assert.throws(() => f.host.handles.get(h(2)), /creation failed/);
  assert.equal(f.host.handles.get(h(4)).kind, "computePipeline");
  f.host.dispose();
});

test("a duplicate pending id is reported without completing the original request", async () => {
  const f = await connected();
  assert.equal(f.apply([["onSubmittedWorkDone", 80], ["onSubmittedWorkDone", 80], ["onSubmittedWorkDone", 81]]), false);
  await settle();
  const duplicate = errorsOf(f);
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].requestId, 0);
  assert.equal(duplicate[0].duplicateRequestId, 80);
  assert.deepEqual(f.terminal(81).map((event) => [event.type, event.status]), [[E.WORK_DONE, S.CANCELLED]]);
  f.mock.resolveWork();
  await settle();
  assert.deepEqual(f.terminal(80).map((event) => [event.type, event.status]), [[E.WORK_DONE, S.OK]]);
  f.host.dispose();
});

test("exactly one terminal event per request id under random cancellation and loss", async () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 20; round++) {
    const f = await connected();
    const ids = [];
    let next = 100;
    for (let step = 0; step < 30; step++) {
      const roll = random();
      if (roll < 0.5) { const id = next++; ids.push(id); f.apply([["onSubmittedWorkDone", id]]); }
      else if (roll < 0.8 && ids.length) f.apply([["cancelRequest", ids[Math.floor(random() * ids.length)]]]);
      else if (roll < 0.9) f.mock.resolveWork();
      else { const id = next++; ids.push(id); f.apply([["onSubmittedWorkDone", id], ["writeBuffer", h(999), 0, { offset: 0, length: 4 }], ["onSubmittedWorkDone", next++]]); ids.push(next - 1); }
      if (random() < 0.3) await tick();
    }
    if (round % 2) f.mock.lost.resolve({ reason: "unknown", message: "random loss" });
    else f.mock.resolveWork();
    await settle();
    for (const id of ids) assert.equal(f.terminal(id).length, 1, `round ${round}: request ${id}`);
    assert.equal(f.host.pendingRequests, 0);
    f.host.dispose();
  }
});

test("command encoders and passes follow the WebGPU recording state machine", async () => {
  const f = await connected();
  const rejected = (operations, pattern) => {
    const count = errorsOf(f).length;
    assert.equal(f.apply(operations), false);
    return tick().then(() => { const errors = errorsOf(f); assert.equal(errors.length, count + 1); assert.match(errors.at(-1).message, pattern); });
  };
  assert.equal(f.apply([
    ["createBuffer", h(1), 256, C.BUFFER_USAGE_COPY_DST | C.BUFFER_USAGE_COPY_SRC | C.BUFFER_USAGE_INDEX, false, "data"],
    ["createCommandEncoder", h(2), "encoder"], ["beginComputePass", h(3), h(2), 0, 0, 0, "pass"],
  ]), true);
  await rejected([["beginComputePass", h(4), h(2), 0, 0, 0, "second"]], /open pass/);
  await rejected([["copyBufferToBuffer", h(2), h(1), 0, h(1), 128, 16]], /open pass/);
  await rejected([["finishCommandEncoder", h(5), h(2), "early"]], /open pass/);
  await rejected([["computeDispatch", h(3), 1, 1, 1]], /without a compute pipeline/);
  assert.equal(f.apply([["endComputePass", h(3)]]), true);
  await rejected([["computeDispatch", h(3), 1, 1, 1]], /pass has ended/);
  await rejected([["endComputePass", h(3)]], /pass has ended/);
  assert.equal(f.apply([["clearBuffer", h(2), h(1), 0, 0], ["finishCommandEncoder", h(6), h(2), "done"]]), true);
  await rejected([["clearBuffer", h(2), h(1), 0, 0]], /has finished/);
  await rejected([["queueSubmit", [h(6), h(6)]]], /listed twice/);
  assert.equal(f.apply([["queueSubmit", [h(6)]]]), true);
  await rejected([["queueSubmit", [h(6)]]], /already submitted/);
  assert.equal(f.apply([
    ["createTexture", h(7), 4, 4, 1, 1, 1, 2, "rgba8unorm", C.TEXTURE_USAGE_RENDER_ATTACHMENT, "target"],
    ["createTextureView", h(8), h(7), "", 0, 0, 0, 0, 0, 0, "view"],
    ["createCommandEncoder", h(9), "render"],
    ["createQuerySet", h(10), C.QUERY_TYPE_OCCLUSION, 2, "occlusion"],
    ["beginRenderPassWith", h(11), h(9), [h(8), 0, C.LOAD_CLEAR, C.STORE_STORE, 0, 0, 0, 1, 0], [], h(10), 0, 0, 0, "pass"],
  ]), true);
  await rejected([["renderDraw", h(11), 3, 1, 0, 0]], /without a render pipeline/);
  await rejected([["createRenderPipelineWith", h(12), 0, h(13), "vs", h(13), "fs", [C.FORMAT_RGBA8UNORM, 15, 0, 0, 0, 0, 0, 0, 0], [], [], [], [], [], "pipeline"], ["destroy", h(12)]], /stale/);
  assert.equal(f.apply([
    ["createShaderModule", h(13), 90, "shader", "shader"],
    ["createRenderPipelineWith", h(14), 0, h(13), "vs", h(13), "fs", [C.FORMAT_RGBA8UNORM, 15, 0, 0, 0, 0, 0, 0, 0], [], [], [], [], [], "pipeline"],
    ["renderSetPipeline", h(11), h(14)], ["renderDraw", h(11), 3, 1, 0, 0],
  ]), true);
  await rejected([["renderDrawIndexed", h(11), 3, 1, 0, 0, 0]], /without an index buffer/);
  assert.equal(f.apply([["renderSetIndexBuffer", h(11), h(1), C.INDEX_UINT16, 0, 0], ["renderDrawIndexed", h(11), 3, 1, 0, 0, 0], ["renderBeginOcclusionQuery", h(11), 0]]), true);
  await rejected([["renderBeginOcclusionQuery", h(11), 1]], /already active/);
  await rejected([["endRenderPass", h(11)]], /still active/);
  assert.equal(f.apply([["renderEndOcclusionQuery", h(11)]]), true);
  await rejected([["renderBeginOcclusionQuery", h(11), 0]], /reused/);
  await rejected([["renderBeginOcclusionQuery", h(11), 2]], /invalid/);
  assert.equal(f.apply([["endRenderPass", h(11)], ["copyTextureToBuffer", h(9), h(7), 0, 0, 0, 0, 0, h(1), 0, 256, 0, 4, 1, 1], ["finishCommandEncoder", h(15), h(9), "render"]]), true);
  await rejected([["createCommandEncoder", h(16), "copy"], ["copyTextureToBuffer", h(16), h(7), 0, 0, 0, 0, 0, h(1), 0, 16, 0, 4, 1, 1]], /multiple of 256/);
  f.host.dispose();
});

test("full render pipeline and pass descriptors translate every schema field", async () => {
  const f = await connected();
  const target = (format, blend) => [format, C.COLOR_WRITE_RED | C.COLOR_WRITE_ALPHA, blend ? 1 : 0, C.BLEND_OP_ADD, C.BLEND_FACTOR_SRC_ALPHA, C.BLEND_FACTOR_ONE_MINUS_SRC_ALPHA, C.BLEND_OP_MAX, C.BLEND_FACTOR_ONE, C.BLEND_FACTOR_CONSTANT];
  const depth = [C.FORMAT_DEPTH24PLUS_STENCIL8, 1, C.COMPARE_LESS, C.COMPARE_EQUAL, C.STENCIL_OP_KEEP, C.STENCIL_OP_INCREMENT_CLAMP, C.STENCIL_OP_REPLACE, 0, 0, 0, 0, 255, 15, -2, 1.5, 0.25];
  const vertex = [8, C.STEP_VERTEX, 1, 0, 0, C.VERTEX_FORMAT_FLOAT32X2, 8, C.STEP_INSTANCE, 2, 1, 0, C.VERTEX_FORMAT_UNORM8X4, 2, 4, C.VERTEX_FORMAT_UINT32];
  const constants = [C.SHADER_STAGE_VERTEX, 1, 0.5, C.SHADER_STAGE_FRAGMENT | C.SHADER_STAGE_VERTEX, 7, 3];
  assert.equal(f.apply([
    ["createShaderModule", h(1), 1000, "shader", "shader"],
    ["createRenderPipelineWith", h(2), 0, h(1), "vs", h(1), "fs", [...target(C.FORMAT_RGBA8UNORM, true), 0, 0, 0, 0, 0, 0, 0, 0, 0, ...target(C.FORMAT_R32UINT, false)], [C.TOPOLOGY_TRIANGLE_STRIP, C.INDEX_UINT16, C.FRONT_FACE_CW, C.CULL_BACK, 0], depth, [4, 0xffffffff, 1], vertex, constants, "mrt"],
  ]), true);
  const descriptor = f.host.handles.get(h(2)).descriptor;
  assert.deepEqual(descriptor.fragment.targets, [
    { format: "rgba8unorm", writeMask: 9, blend: { color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { operation: "max", srcFactor: "one", dstFactor: "constant" } } },
    null,
    { format: "r32uint", writeMask: 9 },
  ]);
  assert.deepEqual(descriptor.primitive, { topology: "triangle-strip", stripIndexFormat: "uint16", frontFace: "cw", cullMode: "back", unclippedDepth: false });
  assert.deepEqual(descriptor.depthStencil, { format: "depth24plus-stencil8", depthWriteEnabled: true, depthCompare: "less", stencilFront: { compare: "equal", failOp: "keep", depthFailOp: "increment-clamp", passOp: "replace" }, stencilBack: { compare: undefined, failOp: undefined, depthFailOp: undefined, passOp: undefined }, stencilReadMask: 255, stencilWriteMask: 15, depthBias: -2, depthBiasSlopeScale: 1.5, depthBiasClamp: 0.25 });
  assert.deepEqual(descriptor.multisample, { count: 4, mask: 0xffffffff, alphaToCoverageEnabled: true });
  assert.deepEqual(descriptor.vertex.buffers, [
    { arrayStride: 8, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
    { arrayStride: 8, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "unorm8x4" }, { shaderLocation: 2, offset: 4, format: "uint32" }] },
  ]);
  assert.deepEqual(descriptor.vertex.constants, { 1: 0.5, 7: 3 });
  assert.deepEqual(descriptor.fragment.constants, { 7: 3 });
  const invalid = [
    [[...target(C.FORMAT_RGBA8UNORM, false)], [], [], [], [8, C.STEP_VERTEX, 2, 0, 0, C.VERTEX_FORMAT_FLOAT32, 0, 4, C.VERTEX_FORMAT_FLOAT32], [], /duplicate GPU shader location/],
    [[...target(C.FORMAT_RGBA8UNORM, false)], [], [], [], [6, C.STEP_VERTEX, 0], [], /stride/],
    [[1, 16, 0, 0, 0, 0, 0, 0, 0], [], [], [], [], [], /write mask/],
    [[1, 15, 2, 0, 0, 0, 0, 0, 0], [], [], [], [], [], /blend flag/],
    [[1, 15, 0, 0, 0, 0, 0, 0, 0], [], [], [], [], [C.SHADER_STAGE_VERTEX, 3, 1, C.SHADER_STAGE_VERTEX, 3, 2], /duplicate GPU pipeline constant/],
    [Array(9 * 9).fill(0), [], [], [], [], [], /record count/],
    [[], [], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [], [], [], /needs a format/],
  ];
  for (const [targets, primitive, depthStencil, multisample, layouts, pipelineConstants] of invalid) {
    assert.equal(f.apply([["createRenderPipelineWith", h(3), 0, h(1), "vs", h(1), "fs", targets, primitive, depthStencil, multisample, layouts, pipelineConstants, "invalid"], ["destroy", h(3)]]), false);
  }
  await settle();
  const messages = errorsOf(f).map((event) => event.message);
  invalid.forEach(([, , , , , , pattern], index) => assert.match(messages[index], pattern));
  assert.equal(f.apply([
    ["createComputePipelineWith", h(4), 0, h(1), "main", [C.SHADER_STAGE_COMPUTE, 0, 64, C.SHADER_STAGE_VERTEX, 0, 1], "compute"],
    ["createTexture", h(5), 4, 4, 1, 1, 1, 2, "rgba8unorm", C.TEXTURE_USAGE_RENDER_ATTACHMENT, "target"],
    ["createTextureView", h(6), h(5), "", 0, 0, 0, 0, 0, 0, "view"],
    ["createCommandEncoder", h(7), "encoder"],
    ["beginRenderPassWith", h(8), h(7), [h(6), h(6), C.LOAD_LOAD, C.STORE_DISCARD, 0.1, 0.2, 0.3, 0.4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0], [h(6), 0, 0, 0.5, 1, C.LOAD_CLEAR, C.STORE_STORE, 9, 0], 0, 0, 0, 0, "mrt pass"],
    ["renderSetStencilReference", h(8), 3], ["renderSetBlendConstant", h(8), 0, 1, 0, 1],
  ]), true);
  assert.deepEqual(f.host.handles.get(h(4)).descriptor.compute.constants, { 0: 64 });
  const pass = f.host.handles.get(h(8));
  assert.deepEqual(pass.descriptor.colorAttachments, [{ view: f.host.handles.get(h(6)), resolveTarget: f.host.handles.get(h(6)), loadOp: "load", storeOp: "discard", clearValue: [0.1, 0.2, 0.3, 0.4], depthSlice: 2 }, null]);
  assert.deepEqual(pass.descriptor.depthStencilAttachment, { view: f.host.handles.get(h(6)), depthLoadOp: undefined, depthStoreOp: undefined, depthClearValue: 0.5, depthReadOnly: true, stencilLoadOp: "clear", stencilStoreOp: "store", stencilClearValue: 9, stencilReadOnly: false });
  assert.deepEqual(pass.calls, [["setStencilReference", 3], ["setBlendConstant", [0, 1, 0, 1]]]);
  f.host.dispose();
});

test("device negotiation reports missing requirements and clamps preferred limits", async () => {
  const f = fixture({ adapterFeatures: ["timestamp-query", "shader-f16"] });
  assert.equal(f.apply([["requestDeviceWith", 1, C.POWER_HIGH_PERFORMANCE, C.FEATURE_DEPTH_CLIP_CONTROL, 0, [C.LIMIT_MAX_BIND_GROUPS, 8, C.LIMIT_MODE_REQUIRED, C.LIMIT_MAX_COLOR_ATTACHMENTS, 16, C.LIMIT_MODE_REQUIRED]]]), true);
  await settle();
  const refused = f.terminal(1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].type, E.CAPABILITIES);
  assert.equal(refused[0].status, S.ERROR);
  assert.equal(refused[0].available, false);
  assert.deepEqual(refused[0].missingFeatures, ["depth-clip-control"]);
  assert.equal(refused[0].missingFeatureBits, C.FEATURE_DEPTH_CLIP_CONTROL);
  assert.deepEqual(refused[0].missingLimits, ["maxBindGroups", "maxColorAttachments"]);
  assert.equal(refused[0].adapterFeatureBits, C.FEATURE_TIMESTAMP_QUERY | C.FEATURE_SHADER_F16);
  assert.equal(f.requested.length, 0);
  assert.equal(f.apply([["requestDeviceWith", 2, C.POWER_LOW_POWER, C.FEATURE_SHADER_F16, C.FEATURE_TIMESTAMP_QUERY | C.FEATURE_SUBGROUPS, [
    C.LIMIT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE, 64, C.LIMIT_MODE_PREFERRED,
    C.LIMIT_MIN_UNIFORM_BUFFER_OFFSET_ALIGNMENT, 64, C.LIMIT_MODE_PREFERRED,
    C.LIMIT_MAX_COLOR_ATTACHMENTS, 4, C.LIMIT_MODE_REQUIRED,
    C.LIMIT_MAX_COMPUTE_WORKGROUPS_PER_DIMENSION, 1, C.LIMIT_MODE_PREFERRED,
  ]]]), true);
  await settle();
  assert.deepEqual(f.requested[0], { requiredFeatures: ["timestamp-query", "shader-f16"], requiredLimits: { maxStorageBuffersPerShaderStage: 10, minUniformBufferOffsetAlignment: 256, maxColorAttachments: 4 } });
  const capabilities = f.terminal(2)[0];
  assert.equal(capabilities.status, S.OK);
  assert.equal(capabilities.featureBits, C.FEATURE_TIMESTAMP_QUERY);
  assert.deepEqual(capabilities.protocol, { version: GPU_PROTOCOL_VERSION, identity: GPU_PROTOCOL_IDENTITY });
  assert.equal(capabilities.formatCode, C.FORMAT_BGRA8UNORM);
  assert.equal(capabilities.adapterLimits.maxStorageBuffersPerShaderStage, 10);
  for (const operation of [
    ["requestDeviceWith", 3, 0, 2 ** 30, 0, []],
    ["requestDeviceWith", 4, 0, 0, 0, [999, 1, C.LIMIT_MODE_REQUIRED]],
    ["requestDeviceWith", 5, 0, 0, 0, [C.LIMIT_MAX_BIND_GROUPS, 1, 3]],
    ["requestDeviceWith", 6, 0, 0, 0, [C.LIMIT_MIN_STORAGE_BUFFER_OFFSET_ALIGNMENT, 48, C.LIMIT_MODE_PREFERRED]],
    ["requestDeviceWith", 7, 0, 0, 0, [C.LIMIT_MAX_BIND_GROUPS, 1, C.LIMIT_MODE_REQUIRED, C.LIMIT_MAX_BIND_GROUPS, 2, C.LIMIT_MODE_REQUIRED]],
    ["requestDeviceWith", 8, 2, 0, 0, []],
  ]) assert.equal(f.apply([operation]), false);
  await settle();
  for (const id of [3, 4, 5, 6, 7, 8]) assert.equal(f.terminal(id)[0].type, E.ERROR);
  f.host.dispose();
  const legacy = fixture({ adapterLimits: { maxBufferSize: 1024 } });
  assert.equal(legacy.apply([["requestDevice", 9, 0, 1, 4096]]), true);
  await settle();
  assert.deepEqual(legacy.terminal(9)[0].missingLimits, ["maxBufferSize"]);
  legacy.host.dispose();
});

test("a cancelled device request destroys a late device and allows another request", async () => {
  const f = fixture();
  assert.equal(f.apply([["requestDeviceWith", 1, 0, 0, 0, []], ["cancelRequest", 1], ["requestDeviceWith", 2, 0, 0, 0, []]]), true);
  await settle();
  assert.deepEqual(f.terminal(1).map((event) => [event.type, event.status]), [[E.CAPABILITIES, S.CANCELLED]]);
  assert.deepEqual(f.terminal(2).map((event) => [event.type, event.status]), [[E.CAPABILITIES, S.OK]]);
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
  await settle();
  assert.equal(events[0].type, E.CAPABILITIES);
  assert.equal(events[0].available, false);
  host.dispose();
});

test("completion releases request ids before delivering the event", async () => {
  let completions = 0;
  const f = fixture({ onEvent: (event) => {
    if (event.type !== E.WORK_DONE) return;
    completions++;
    if (completions === 1) f.host.onSubmittedWorkDone(99);
  } });
  f.host.requestDevice(1, 1, 1, 0);
  await settle();
  f.host.onSubmittedWorkDone(99);
  f.mock.resolveWork();
  await settle();
  assert.equal(completions, 1);
  f.mock.resolveWork();
  await settle();
  assert.equal(completions, 2);
  assert.equal(f.events.some((event) => event.type === E.ERROR), false);
  f.host.dispose();
});

test("dispose suppresses every later event", async () => {
  const f = await connected();
  f.apply([["onSubmittedWorkDone", 5]]);
  const count = f.events.length;
  f.host.dispose();
  f.mock.resolveWork();
  f.mock.lost.resolve({ reason: "destroyed", message: "dispose" });
  await settle();
  assert.equal(f.events.length, count);
  assert.equal(f.mock.device.destroyed, true);
});

test("GpuHandles is exported for diagnostics", () => assert.equal(typeof GpuHandles, "function"));
