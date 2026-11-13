// Native executor on the real device (wgpu-native, Metal): protocol semantics of gpu/host.js (handles, generations,
// rejection, requests, cancellation, loss, limits, arenas), real compute, texture and canvas readback, every one of
// the 64 operations executing on WebGPU, event JSON shapes and idle behaviour. Builds with build-executor.sh; the
// outputs live in the dependency cache (or $NTGPU_EXECUTOR_BUILD_DIR), never in the worktree.
//   node --test gpu/native/executor.test.mjs      (NTGPU_EXECUTOR_SANITIZE=address|thread for sanitizer builds)
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver, connect, encode, header, C, E, S, h } from "./executor-client.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const skip = process.platform !== "darwin" || process.arch !== "arm64" ? "macOS arm64 only" : false;
let build = null;
// NTGPU_EXECUTOR_SANITIZE=address|thread builds and runs the drivers under ASan+UBSan or TSan.
const sanitize = process.env.NTGPU_EXECUTOR_SANITIZE ? ["--sanitize", process.env.NTGPU_EXECUTOR_SANITIZE] : [];
before(() => { if (!skip) build = execFileSync(join(here, "build-executor.sh"), sanitize, { encoding: "utf8" }).trim().split("\n").pop(); });
const drivers = [];
after(async () => { for (const driver of drivers) await driver.quit(); });
async function start(args = []) {
  const driver = await Driver.start(join(build, "ntgpu-executor-driver"), args);
  drivers.push(driver);
  return driver;
}
async function connected(options) {
  const driver = await start();
  driver.device = await connect(driver, 1, options);
  return driver;
}
const READBACK = C.BUFFER_USAGE_MAP_READ | C.BUFFER_USAGE_COPY_DST;
const u32s = (values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const f32s = (values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
const keys = (event) => Object.keys(event);
const quiet = (driver) => driver.events.filter((event) => event.type === E.ERROR || event.type === E.UNCAUGHT_ERROR);
// Records in gpu/ops.json field order.
const bindGroupLayoutEntry = (binding, visibility, kind, type, { dynamic = 0, minSize = 0, dimension = 0, multisampled = 0, format = 0, access = 0 } = {}) => [binding, visibility, kind, type, dynamic, minSize, dimension, multisampled, format, access];
const colorTarget = (format, writeMask = C.COLOR_WRITE_ALL, blend = null) => [format, writeMask, blend ? 1 : 0, ...(blend ?? [0, 0, 0, 0, 0, 0])];
const colorAttachment = (view, load, store, [r, g, b, a] = [0, 0, 0, 0], resolve = 0) => [view, resolve, load, store, r, g, b, a, 0];
const depthStencil = (format, depthWrite, depthCompare, compare, pass, readMask = 255, writeMask = 255) => [format, depthWrite, depthCompare, compare, C.STENCIL_OP_KEEP, C.STENCIL_OP_KEEP, pass, compare, C.STENCIL_OP_KEEP, C.STENCIL_OP_KEEP, pass, readMask, writeMask, 0, 0, 0];

test("batches without the exact header or with malformed operations are fatal and execute nothing", { skip }, async () => {
  const d = await connected();
  const make = [["createBuffer", h(9), 64, C.BUFFER_USAGE_COPY_DST, false, "never"]];
  for (const head of [null, header(C.GPU_PROTOCOL_VERSION + 1), header(C.GPU_PROTOCOL_VERSION, (C.GPU_PROTOCOL_IDENTITY ^ 1) >>> 0)]) {
    assert.equal((await d.submit(encode(make, head))).submit, 0);
  }
  assert.equal((await d.submit(Buffer.concat([header(), Buffer.from([255])]))).submit, 0);
  assert.equal((await d.submit(Buffer.concat([header(), Buffer.from([39, 1, 0])]))).submit, 0);
  const errors = d.errors();
  assert.equal(errors.length, 5);
  assert.ok(errors.every((event) => event.fatal === true && event.requestId === 0 && event.status === S.ERROR));
  assert.match(errors[0].message, /no protocol header/);
  assert.match(errors[2].message, /identity mismatch/);
  assert.match(errors[3].message, /unknown GPU opcode/);
  assert.match(errors[4].message, /truncated/);
  // h(9) was never reserved: generation 1 is still the next one.
  assert.equal((await d.submit(make)).submit, 1);
});

test("a rejected operation cancels later requests once, still retires handles and keeps frames", { skip }, async () => {
  const d = await connected();
  const result = await d.submit([
    ["createBuffer", h(1), 16, READBACK, false, "readback"],
    ["writeBuffer", h(77), 0, { offset: 0, length: 4 }],
    ["createBuffer", h(2), 16, C.BUFFER_USAGE_COPY_DST, false, "never created"],
    ["mapAsync", 5, h(1), C.MAP_MODE_READ, 0, 16, { offset: 0, length: 16 }],
    ["onSubmittedWorkDone", 6],
    ["destroy", h(1)],
    ["destroy", h(2)],
    ["requestFrame"],
  ], { uploads: Buffer.alloc(16) });
  assert.equal(result.submit, 0);
  const errors = d.errors();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /stale/);
  assert.notEqual(errors[0].fatal, true);
  assert.deepEqual(d.terminal(5).map((event) => [event.type, event.status, event.message]), [[E.MAP_READY, S.CANCELLED, "GPU batch aborted before this request"]]);
  assert.deepEqual(d.terminal(6).map((event) => [event.type, event.status]), [[E.WORK_DONE, S.CANCELLED]]);
  assert.equal(d.frames, 1);
  // Both slots advanced to generation 2, exactly as the guest allocator did.
  assert.equal((await d.submit([["createBuffer", h(1, 2), 16, READBACK, false, "again"], ["createBuffer", h(2, 2), 16, READBACK, false, "again"]])).submit, 1);
  assert.equal((await d.stats()).live, 2);
});

test("stale, wrong-type and failed handles are reported; generations retire at 4095 without wrapping", { skip }, async () => {
  const d = await connected();
  await d.submit([["createBuffer", h(1), 16, C.BUFFER_USAGE_COPY_DST, false, "b"]]);
  const cases = [
    [["createTextureView", h(2), h(1), "", 0, 0, 0, 0, 0, 0, "v"]], /GPU handle is buffer, expected texture/,
    [["createBuffer", h(1), 16, C.BUFFER_USAGE_COPY_DST, false, "dup"]], /stale or duplicate GPU handle/,
    [["createBuffer", h(3, 2), 16, C.BUFFER_USAGE_COPY_DST, false, "skip"]], /unissued GPU handle generation/,
    [["destroy", h(1, 2)]], /stale GPU handle/,
    [["createBuffer", 7 * 2 ** 20, 16, 0, false, "slot 0"]], /invalid GPU handle$/,
    [["createTexture", h(4), 4, 4, 1, 1, 1, C.DIMENSION_2D, "not-a-format", C.TEXTURE_USAGE_COPY_DST, "t"]], /unsupported GPU texture format/,
  ];
  for (let i = 0; i < cases.length; i += 2) {
    const before = d.errors().length;
    assert.equal((await d.submit(cases[i])).submit, 0);
    assert.match(d.errors()[before].message, cases[i + 1]);
  }
  // The failed texture stays allocated until the guest retires it.
  await d.submit([["createTextureView", h(5), h(4), "", 0, 0, 0, 0, 0, 0, "v"]]);
  assert.match(d.errors().at(-1).message, /creation failed/);
  assert.equal((await d.submit([["destroy", h(4)], ["createTexture", h(4, 2), 4, 4, 1, 1, 1, C.DIMENSION_2D, "rgba8unorm", C.TEXTURE_USAGE_COPY_DST, "t"]])).submit, 1);
  // Retire slot 6 through all 4095 generations (rejected-before-reservation path), then it stays retired.
  const cycle = [];
  for (let g = 1; g <= 4094; g++) cycle.push(["destroy", h(6, g)]);
  assert.equal((await d.submit(cycle)).submit, 1);
  assert.equal((await d.submit([["createBuffer", h(6, 4095), 16, C.BUFFER_USAGE_COPY_DST, false, "last"], ["destroy", h(6, 4095)]])).submit, 1);
  const before = d.errors().length;
  assert.equal((await d.submit([["createBuffer", h(6, 1), 16, C.BUFFER_USAGE_COPY_DST, false, "wrapped"]])).submit, 0);
  assert.match(d.errors()[before].message, /stale or duplicate/);
  assert.equal(d.events.filter((event) => event.type === E.UNCAUGHT_ERROR).length, 0);
});

test("readback bounds, alignment and overlapping destinations are refused with the request id", { skip }, async () => {
  const d = await connected();
  await d.submit([["createBuffer", h(1), 64, READBACK, false, "readback"], ["createBuffer", h(2), 64, READBACK, false, "readback"]]);
  const cases = [
    [10, h(1), 4, 16, { offset: 0, length: 16 }, /multiple of 8/],
    [11, h(1), 0, 6, { offset: 0, length: 16 }, /multiple of 4/],
    [12, h(1), 0, 128, { offset: 0, length: 128 }, /outside buffer/],
    [13, h(1), 0, 32, { offset: 0, length: 16 }, /outside staging/],
    [14, h(1), 0, 16, { offset: 16380, length: 16 }, /outside staging/],
  ];
  for (const [id, buffer, offset, size, destination] of cases) {
    assert.equal((await d.submit([["mapAsync", id, buffer, C.MAP_MODE_READ, offset, size, destination]], { readback: 16384 })).submit, 0);
  }
  // Natively a map completes as soon as its batch ends, so the conflicting map shares the batch.
  assert.equal((await d.submit([["mapAsync", 20, h(1), C.MAP_MODE_READ, 0, 16, { offset: 0, length: 16 }], ["mapAsync", 21, h(2), C.MAP_MODE_READ, 0, 16, { offset: 8, length: 16 }]], { readback: 16384 })).submit, 0);
  assert.equal((await d.submit([["mapAsync", 23, h(2), C.MAP_MODE_READ, 0, 16, { offset: 512, length: 16 }], ["mapAsync", 22, h(2), C.MAP_MODE_READ, 0, 16, { offset: 64, length: 16 }]], { readback: 16384 })).submit, 0);
  for (const [id, , , , , message] of cases) {
    const [event] = d.terminal(id);
    assert.equal(event.type, E.ERROR);
    assert.equal(event.handle, h(1));
    assert.match(event.message, message);
  }
  assert.match(d.terminal(21)[0].message, /in use by a pending request/);
  assert.match(d.terminal(22)[0].message, /pending map/);
  await d.wait();
  assert.deepEqual(d.terminal(20).map((event) => [event.type, event.status, event.offset, event.length]), [[E.MAP_READY, S.OK, 0, 16]]);
  assert.deepEqual(d.terminal(23).map((event) => [event.type, event.status, event.offset, event.length]), [[E.MAP_READY, S.OK, 512, 16]]);
});

test("external device loss settles every pending request once with LOST before DEVICE_LOST", { skip }, async () => {
  const d = await connected();
  await d.submit([
    ["createBuffer", h(1), 256, READBACK, false, "readback"],
    ["createShaderModule", h(2), 3, "@compute @workgroup_size(1) fn main() {}", "m"],
    ["mapAsync", 4, h(1), C.MAP_MODE_READ, 0, 256, { offset: 0, length: 256 }],
    ["onSubmittedWorkDone", 5],
  ]);
  await d.lose();
  await d.wait();
  const lossAt = d.events.findIndex((event) => event.type === E.DEVICE_LOST);
  assert.ok(lossAt > 0);
  assert.equal(d.events[lossAt].reason, "destroyed");
  for (const id of [4, 5]) {
    const events = d.terminal(id);
    assert.equal(events.length, 1);
    assert.ok(events[0].status === S.LOST || events[0].status === S.OK, JSON.stringify(events[0]));
    assert.ok(d.events.indexOf(events[0]) < lossAt);
  }
  // Lost handles stay allocated; using one is refused; retiring one is not an error.
  await d.submit([["mapAsync", 6, h(1), C.MAP_MODE_READ, 0, 256, { offset: 0, length: 256 }]]);
  assert.match(d.terminal(6)[0].message, /lost with its device|device unavailable/);
  const errors = d.errors().length;
  assert.equal((await d.submit([["destroy", h(1)], ["release", h(2)], ["requestFrame"]])).submit, 1);
  assert.equal(d.errors().length, errors);
  assert.equal(d.frames, 0, "requestFrame without a device is ignored");
  assert.equal((await d.stats()).pending, 0);
});

test("destroyDevice settles pending work synchronously and allows a restart", { skip }, async () => {
  const d = await connected();
  const result = await d.submit([
    ["createBuffer", h(1), 256, READBACK, false, "readback"],
    ["createShaderModule", h(2), 3, "@compute @workgroup_size(1) fn main() {}", "m"],
    ["mapAsync", 4, h(1), C.MAP_MODE_READ, 0, 256, { offset: 0, length: 256 }],
    ["onSubmittedWorkDone", 5],
    ["createComputePipelineAsync", h(3), 6, 0, h(2), "main", "p"],
    ["destroyDevice"],
  ]);
  assert.equal(result.submit, 1);
  const loss = result.events.findIndex((event) => event.type === E.DEVICE_LOST);
  assert.deepEqual(result.events.slice(0, loss).filter((event) => event.requestId !== 3).map((event) => [event.requestId, event.type, event.status]), [[4, E.MAP_READY, S.LOST], [5, E.WORK_DONE, S.LOST], [6, E.PIPELINE_READY, S.LOST]]);
  assert.equal(result.events[loss].message, "GPU device destroyed by the guest");
  assert.equal(d.terminal(3).length, 1, "shader info of the module created before the loss completes once");
  assert.equal((await d.wait()).wait, "idle");
  assert.equal(d.terminal(4).length + d.terminal(5).length + d.terminal(6).length, 3, "late native completions are dropped");
  // A second destroy has no device; the restart negotiates a new one and the lost handles retire cleanly.
  assert.equal((await d.submit([["destroyDevice"]])).submit, 0);
  assert.match(d.errors().at(-1).message, /device unavailable/);
  const restarted = await connect(d, 7);
  assert.equal(restarted.available, true);
  const errors = d.errors().length;
  assert.equal((await d.submit([["destroy", h(1)], ["destroy", h(2)], ["destroy", h(3)], ["createBuffer", h(1, 2), 16, READBACK, false, "new"]])).submit, 1);
  assert.equal(d.errors().length, errors);
});

test("cancellation, unmap and destroy complete a pending map exactly once", { skip }, async () => {
  const d = await connected();
  await d.submit([1, 2, 3, 4].map((slot) => ["createBuffer", h(slot), 256, READBACK, false, "spare"]));
  await d.submit([
    ["mapAsync", 10, h(1), C.MAP_MODE_READ, 0, 256, { offset: 0, length: 256 }],
    ["cancelRequest", 10],
    ["mapAsync", 11, h(1), C.MAP_MODE_READ, 0, 256, { offset: 0, length: 256 }],
    ["mapAsync", 12, h(2), C.MAP_MODE_READ, 0, 256, { offset: 256, length: 256 }],
    ["unmap", h(2)],
    ["mapAsync", 13, h(3), C.MAP_MODE_READ, 0, 256, { offset: 512, length: 256 }],
    ["destroy", h(3)],
    ["mapAsync", 14, h(4), C.MAP_MODE_READ, 0, 256, { offset: 768, length: 256 }],
    ["cancelRequest", 99],
  ]);
  await d.wait();
  assert.deepEqual([10, 11, 12, 13, 14].map((id) => d.terminal(id).map((event) => [event.type, event.status])), [
    [[E.MAP_READY, S.CANCELLED]], [[E.MAP_READY, S.OK]], [[E.MAP_READY, S.CANCELLED]], [[E.MAP_READY, S.CANCELLED]], [[E.MAP_READY, S.OK]],
  ]);
  assert.equal(d.terminal(12)[0].message, "GPU map cancelled by unmap");
  assert.equal(d.terminal(13)[0].message, "GPU request cancelled by releasing its resource");
  // Mapped buffers come back unmapped: they map again, and unmap of an unmapped buffer is a no-op.
  await d.submit([["unmap", h(4)], ["mapAsync", 15, h(4), C.MAP_MODE_READ, 0, 256, { offset: 0, length: 256 }], ["mapAsync", 16, h(2), C.MAP_MODE_READ, 0, 256, { offset: 256, length: 256 }]]);
  await d.wait();
  assert.deepEqual([15, 16].map((id) => d.terminal(id)[0].status), [S.OK, S.OK]);
  assert.deepEqual(quiet(d), []);
});

test("async pipelines: cancelled or released complete once, failures report and stay unusable", { skip }, async () => {
  const d = await connected();
  const code = "@compute @workgroup_size(1) fn main() {}";
  await d.submit([
    ["createShaderModule", h(1), 1, code, "m"],
    ["createComputePipelineAsync", h(2), 2, 0, h(1), "main", "cancelled"],
    ["cancelRequest", 2],
    ["createComputePipelineAsync", h(3), 3, 0, h(1), "main", "released"],
    ["release", h(3)],
    ["createComputePipelineAsync", h(4), 4, 0, h(1), "missing", "fails"],
    ["createComputePipelineAsync", h(5), 5, 0, h(1), "main", "ok"],
  ]);
  assert.deepEqual([2, 3, 4, 5].map((id) => d.terminal(id).map((event) => [event.type, event.status])), [
    [[E.PIPELINE_READY, S.CANCELLED]], [[E.PIPELINE_READY, S.CANCELLED]], [[E.ERROR, S.ERROR]], [[E.PIPELINE_READY, S.OK]],
  ]);
  assert.match(d.terminal(4)[0].message, /missing|entry/i);
  const before = d.errors().length;
  await d.submit([["createCommandEncoder", h(6), "e"], ["beginComputePass", h(7), h(6), 0, 0, 0, "p"], ["computeSetPipeline", h(7), h(2)]]);
  assert.match(d.errors()[before].message, /creation failed/);
  await d.submit([["computeSetPipeline", h(7), h(4)]]);
  assert.match(d.errors().at(-1).message, /creation failed/);
  assert.equal((await d.submit([["computeSetPipeline", h(7), h(5)], ["computeDispatch", h(7), 1, 1, 1], ["endComputePass", h(7)]])).submit, 1);
  assert.equal(d.events.filter((event) => event.type === E.UNCAUGHT_ERROR).length, 0);
});

test("a duplicate pending id is reported without completing the original request; at most 1024 are pending", { skip }, async () => {
  const d = await connected();
  // In one batch, so request 7 is certainly still pending (natively it completes as soon as the batch ends).
  const result = await d.submit([
    ["createBuffer", h(1), 16, READBACK, false, "b"], ["createBuffer", h(2), 16, READBACK, false, "b"],
    ["mapAsync", 7, h(1), C.MAP_MODE_READ, 0, 16, { offset: 0, length: 16 }],
    ["mapAsync", 7, h(2), C.MAP_MODE_READ, 0, 16, { offset: 64, length: 16 }],
    ["onSubmittedWorkDone", 7],
  ]);
  assert.equal(result.submit, 0);
  const [duplicate, skipped] = d.errors();
  assert.equal(duplicate.requestId, 0);
  assert.equal(duplicate.duplicateRequestId, 7);
  assert.equal(duplicate.handle, h(2));
  assert.match(duplicate.message, /duplicate pending GPU request id 7/);
  assert.equal(skipped.message, "GPU request id is already pending");
  assert.equal(skipped.duplicateRequestId, 7);
  await d.wait();
  assert.equal(d.terminal(7).length, 1);
  assert.equal(d.terminal(7)[0].type, E.MAP_READY);
  // 1024 requests may be pending; the 1025th is refused with its id.
  const many = [];
  for (let id = 100; id < 1124; id++) many.push(["onSubmittedWorkDone", id]);
  assert.equal((await d.submit([...many, ["onSubmittedWorkDone", 2000]])).submit, 0);
  assert.equal(d.terminal(2000)[0].message, "too many pending GPU requests");
  assert.equal((await d.wait()).wait, "idle");
  for (let id = 100; id < 1124; id++) assert.equal(d.terminal(id).length, 1);
  assert.equal((await d.submit([["onSubmittedWorkDone", 0]])).submit, 0);
  assert.equal(d.errors().at(-1).message, "invalid GPU request id");
});

test("device negotiation reports missing features and limits, clamps preferred limits and validates requests", { skip }, async () => {
  const d = await start();
  await d.submit([["requestDeviceWith", 1, C.POWER_HIGH_PERFORMANCE, C.FEATURE_CORE_FEATURES_AND_LIMITS, 0, [C.LIMIT_MAX_BIND_GROUPS, 1e6, C.LIMIT_MODE_REQUIRED]]]);
  const refused = d.terminal(1)[0];
  assert.equal(refused.status, S.ERROR);
  assert.deepEqual(keys(refused), ["type", "requestId", "handle", "status", "available", "reason", "missingFeatures", "missingFeatureBits", "missingLimits", "adapterFeatures", "adapterFeatureBits", "adapterLimits"]);
  assert.deepEqual(refused.missingFeatures, ["core-features-and-limits"]);
  assert.equal(refused.missingFeatureBits, C.FEATURE_CORE_FEATURES_AND_LIMITS);
  assert.deepEqual(refused.missingLimits, ["maxBindGroups"]);
  const rejects = [
    [[2, C.POWER_HIGH_PERFORMANCE, 1 << 25, 0, []], /unsupported GPU feature bits/],
    [[3, 7, 0, 0, []], /unsupported GPU enum 7/],
    [[4, 0, 0, 0, [C.LIMIT_MAX_BIND_GROUPS, 4]], /invalid GPU limitRequest record/],
    [[5, 0, 0, 0, [99, 4, C.LIMIT_MODE_REQUIRED]], /unsupported GPU limit 99/],
    [[6, 0, 0, 0, [C.LIMIT_MAX_BIND_GROUPS, 4, 1, C.LIMIT_MAX_BIND_GROUPS, 4, 1]], /duplicate GPU limit maxBindGroups/],
    [[7, 0, 0, 0, [C.LIMIT_MIN_UNIFORM_BUFFER_OFFSET_ALIGNMENT, 48, C.LIMIT_MODE_PREFERRED]], /must be a power of two/],
    [[8, 0, 0, 0, [C.LIMIT_MAX_BIND_GROUPS, 4, 3]], /invalid GPU limit mode 3/],
  ];
  for (const [args, message] of rejects) {
    assert.equal((await d.submit([["requestDeviceWith", ...args]])).submit, 0);
    assert.match(d.terminal(args[0])[0].message, message);
  }
  // Legacy requestDevice: featureBits 1 (timestamp-query, optional) and a maxBufferSize requirement.
  assert.equal((await d.submit([["requestDevice", 9, C.POWER_LOW_POWER, 1, 64 * 1024 * 1024], ["requestDevice", 10, 0, 0, 0]])).submit, 0);
  assert.match(d.terminal(10)[0].message, /already requested/);
  const device = d.terminal(9)[0];
  assert.equal(device.status, S.OK);
  assert.deepEqual(keys(device), ["type", "requestId", "handle", "status", "available", "features", "featureBits", "adapterFeatures", "adapterFeatureBits", "limits", "adapterLimits", "format", "formatCode", "protocol"]);
  assert.equal(device.format, "bgra8unorm");
  assert.equal(device.formatCode, C.FORMAT_BGRA8UNORM);
  assert.equal(device.limits.maxBufferSize >= 64 * 1024 * 1024, true);
  assert.equal(Object.keys(device.limits).length >= 31, true);
  assert.equal(device.features.includes("timestamp-query"), device.adapterFeatures.includes("timestamp-query"));
  assert.equal(device.featureBits & 1, device.features.includes("timestamp-query") ? 1 : 0);
  const resize = d.events.find((event) => event.type === E.RESIZE);
  assert.deepEqual(resize, { type: E.RESIZE, requestId: 0, handle: 0, status: S.OK, width: 64, height: 64, dpr: 1 });
  // A restart may prefer a limit beyond the adapter (clamped to the adapter) and require a feature it has.
  await d.submit([["destroyDevice"]]);
  await connect(d, 11, { featureBits: 0, limits: [C.LIMIT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE, 1e6, C.LIMIT_MODE_PREFERRED, C.LIMIT_MAX_COLOR_ATTACHMENTS, 4, C.LIMIT_MODE_REQUIRED] });
  const clamped = d.terminal(11)[0];
  assert.equal(clamped.limits.maxStorageBuffersPerShaderStage, clamped.adapterLimits.maxStorageBuffersPerShaderStage);
  assert.equal(clamped.limits.maxColorAttachments, 8, "a request worse than the default gets the default");
  await d.submit([["destroyDevice"], ["requestDeviceWith", 12, 0, 0, 0, []], ["cancelRequest", 12]]);
  assert.deepEqual(d.terminal(12).map((event) => [event.type, event.status]), [[E.CAPABILITIES, S.CANCELLED]]);
  assert.equal((await connect(d, 13)).available, true);
});

test("every one of the 64 operations executes on the real device with exact compute, texture and canvas results", { skip }, async () => {
  const d = await start(["--width", "8", "--height", "8", "--dpr", "2"]);
  await d.submit([["requestDevice", 1, C.POWER_HIGH_PERFORMANCE, 1, 0]]);
  const device = d.terminal(1)[0];
  assert.equal(device.status, S.OK);
  const timestamps = device.features.includes("timestamp-query");
  const used = new Set(["requestDevice"]);
  const run = async (operations, options) => {
    for (const [name] of operations) used.add(name);
    const result = await d.submit(operations, options);
    assert.equal(result.submit, 1, JSON.stringify(result.events));
    return result;
  };
  const computeCode = `@id(7) override scale: u32 = 1u;
@group(0) @binding(0) var<storage, read_write> data: array<u32, 64>;
@compute @workgroup_size(64) fn fill(@builtin(local_invocation_index) i: u32) { data[i] = data[i] * scale + 1u; }`;
  const renderCode = `struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@location(0) p: vec2f) -> VOut { var o: VOut; o.pos = vec4f(p, 0.0, 1.0); o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); return o; }
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn textured(i: VOut) -> @location(0) vec4f { return textureSampleLevel(tex, samp, i.uv, 0.0); }
@fragment fn white() -> @location(0) vec4f { return vec4f(1.0, 1.0, 1.0, 1.0); }
@fragment fn red() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }`;
  // Texture pattern: texel (x, y) = (40x+10, 40y+20, 7, 255).
  const pattern = Buffer.alloc(64), staged = Buffer.alloc(1024);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { pattern.set([40 * x + 10, 40 * y + 20, 7, 255], y * 16 + x * 4); staged.set([1, 2, 3, 4], y * 256 + x * 4); }
  const quad = f32s([-1, 1, 1, 1, -1, -1, 1, -1]), triangles = f32s([-1, 1, 1, 1, -1, -1, -1, -1, 1, 1, 1, -1]);
  const uploads = Buffer.concat([u32s([...Array(64).keys()]), u32s([1, 1, 1]), u32s([6, 1, 0, 0]), u32s([6, 1, 0, 0, 0]), pattern, staged, quad, triangles, u32s([0x00010000, 0x00020002, 0x00030001]), Buffer.alloc(256, 0xab)]);
  let at = 0;
  const slice = (length) => { const range = { offset: at, length }; at += length; return range; };
  const [dataInit, indirect, drawArgs, drawIndexedArgs, patternRange, stagedRange, quadRange, trianglesRange, indexRange, fill] = [256, 12, 16, 20, 64, 1024, 32, 48, 12, 256].map(slice);
  const vertexLayout = [8, C.STEP_VERTEX, 1, 0, 0, C.VERTEX_FORMAT_FLOAT32X2];
  const texturedLayout = [...bindGroupLayoutEntry(0, C.SHADER_STAGE_FRAGMENT, C.BINDING_TEXTURE, C.TEXTURE_SAMPLE_FLOAT, { dimension: C.VIEW_2D }), ...bindGroupLayoutEntry(1, C.SHADER_STAGE_FRAGMENT, C.BINDING_SAMPLER, C.SAMPLER_FILTERING)];
  const stencilWrite = depthStencil(C.FORMAT_DEPTH24PLUS_STENCIL8, 0, C.COMPARE_ALWAYS, C.COMPARE_ALWAYS, C.STENCIL_OP_REPLACE);
  const stencilEqual = depthStencil(C.FORMAT_DEPTH24PLUS_STENCIL8, 0, C.COMPARE_ALWAYS, C.COMPARE_EQUAL, C.STENCIL_OP_KEEP);
  const constantBlend = [C.BLEND_OP_ADD, C.BLEND_FACTOR_CONSTANT, C.BLEND_FACTOR_ZERO, C.BLEND_OP_ADD, C.BLEND_FACTOR_ONE, C.BLEND_FACTOR_ZERO];
  const primitive = [C.TOPOLOGY_TRIANGLE_LIST, 0, C.FRONT_FACE_CCW, C.CULL_NONE, 0];
  await run([
    ["createShaderModule", h(1), 10, computeCode, "compute"],
    ["createShaderModule", h(2), 11, renderCode, "render"],
    ["createBindGroupLayout", h(3), bindGroupLayoutEntry(0, C.SHADER_STAGE_COMPUTE, C.BINDING_BUFFER, C.BUFFER_BINDING_STORAGE, { minSize: 256 }), "storage"],
    ["createPipelineLayout", h(4), [h(3)], "compute layout"],
    ["createBindGroupLayout", h(5), texturedLayout, "textured"],
    ["createPipelineLayout", h(6), [h(5)], "render layout"],
    ["createBuffer", h(10), 256, C.BUFFER_USAGE_STORAGE | C.BUFFER_USAGE_COPY_SRC | C.BUFFER_USAGE_COPY_DST, true, "data"],
    ["writeMappedBuffer", h(10), 0, dataInit],
    ["unmap", h(10)],
    ["createBuffer", h(11), 12, C.BUFFER_USAGE_INDIRECT | C.BUFFER_USAGE_COPY_DST, false, "dispatch args"],
    ["createBuffer", h(12), 16, C.BUFFER_USAGE_INDIRECT | C.BUFFER_USAGE_COPY_DST, false, "draw args"],
    ["createBuffer", h(13), 20, C.BUFFER_USAGE_INDIRECT | C.BUFFER_USAGE_COPY_DST, false, "draw indexed args"],
    ["createBuffer", h(14), 1024, C.BUFFER_USAGE_COPY_SRC | C.BUFFER_USAGE_COPY_DST, false, "texture staging"],
    ["createBuffer", h(15), 32, C.BUFFER_USAGE_VERTEX | C.BUFFER_USAGE_COPY_DST, false, "quad"],
    ["createBuffer", h(16), 12, C.BUFFER_USAGE_INDEX | C.BUFFER_USAGE_COPY_DST, false, "indices"],
    ["createBuffer", h(17), 48, C.BUFFER_USAGE_VERTEX | C.BUFFER_USAGE_COPY_DST, false, "triangles"],
    ["createBuffer", h(18), 256, C.BUFFER_USAGE_COPY_SRC | C.BUFFER_USAGE_COPY_DST, false, "cleared"],
    ["createBuffer", h(19), 512, C.BUFFER_USAGE_QUERY_RESOLVE | C.BUFFER_USAGE_COPY_SRC, false, "resolve"],
    ["writeBuffer", h(11), 0, indirect], ["writeBuffer", h(12), 0, drawArgs], ["writeBuffer", h(13), 0, drawIndexedArgs],
    ["writeBuffer", h(14), 0, stagedRange], ["writeBuffer", h(15), 0, quadRange], ["writeBuffer", h(16), 0, indexRange],
    ["writeBuffer", h(17), 0, trianglesRange], ["writeBuffer", h(18), 0, fill],
    ["createBindGroup", h(20), h(3), [0, C.BINDING_BUFFER, h(10), 0, 256], "data group"],
    ["createComputePipeline", h(21), h(4), h(1), "fill", "sync"],
    ["createComputePipelineAsync", h(22), 12, h(4), h(1), "fill", "async"],
    ["createComputePipelineWith", h(23), h(4), h(1), "fill", [C.SHADER_STAGE_COMPUTE, 7, 2], "sync x2"],
    ["createComputePipelineAsyncWith", h(24), 13, h(4), h(1), "fill", [C.SHADER_STAGE_COMPUTE, 7, 3], "async x3"],
    ["createTexture", h(30), 4, 4, 1, 1, 1, C.DIMENSION_2D, "rgba8unorm", C.TEXTURE_USAGE_COPY_DST | C.TEXTURE_USAGE_COPY_SRC, "pattern"],
    ["writeTexture", h(30), 0, 0, 0, 0, C.ASPECT_ALL, patternRange, 16, 4, 4, 4, 1],
    ["createTexture", h(31), 4, 4, 1, 1, 1, C.DIMENSION_2D, "rgba8unorm", C.TEXTURE_USAGE_COPY_DST | C.TEXTURE_USAGE_TEXTURE_BINDING, "sampled"],
    ["createTexture", h(32), 4, 4, 1, 1, 1, C.DIMENSION_2D, "rgba8unorm", C.TEXTURE_USAGE_COPY_DST | C.TEXTURE_USAGE_COPY_SRC, "staged"],
    ["createTextureView", h(33), h(31), "", C.VIEW_2D, 0, 1, 0, 1, C.ASPECT_ALL, "sampled view"],
    ["createSampler", h(34), C.ADDRESS_CLAMP_TO_EDGE, C.ADDRESS_CLAMP_TO_EDGE, C.ADDRESS_REPEAT, C.FILTER_NEAREST, C.FILTER_NEAREST, C.FILTER_NEAREST, 0, 32, 0, 1, "nearest"],
    ["createTexture", h(35), 4, 4, 1, 1, 1, C.DIMENSION_2D, "rgba8unorm", C.TEXTURE_USAGE_RENDER_ATTACHMENT | C.TEXTURE_USAGE_COPY_SRC, "target"],
    ["createTextureView", h(36), h(35), "", 0, 0, 0, 0, 0, C.ASPECT_ALL, "target view"],
    ["createTexture", h(37), 4, 4, 1, 1, 1, C.DIMENSION_2D, "depth24plus-stencil8", C.TEXTURE_USAGE_RENDER_ATTACHMENT, "depth"],
    ["createTextureView", h(38), h(37), "", 0, 0, 0, 0, 0, C.ASPECT_ALL, "depth view"],
    ["createBindGroup", h(39), h(5), [0, C.BINDING_TEXTURE, h(33), 0, 0, 1, C.BINDING_SAMPLER, h(34), 0, 0], "textured group"],
    ["createRenderPipeline", h(40), h(6), h(2), "vs", h(2), "textured", "rgba8unorm", "", C.TOPOLOGY_TRIANGLE_LIST, C.FRONT_FACE_CCW, C.CULL_NONE, 1, false, 0, 0, vertexLayout, "legacy sync"],
    ["createRenderPipelineAsync", h(41), 14, h(6), h(2), "vs", h(2), "textured", "rgba8unorm", "", C.TOPOLOGY_TRIANGLE_LIST, C.FRONT_FACE_CCW, C.CULL_NONE, 1, false, 0, 1, vertexLayout, "legacy async"],
    ["createRenderPipelineWith", h(42), 0, h(2), "vs", h(2), "white", colorTarget(C.FORMAT_RGBA8UNORM, C.COLOR_WRITE_ALL, constantBlend), primitive, stencilWrite, [1, 0xffffffff, 0], vertexLayout, [], "stencil writer"],
    ["createRenderPipelineAsyncWith", h(43), 15, h(6), h(2), "vs", h(2), "textured", colorTarget(C.FORMAT_RGBA8UNORM), primitive, stencilEqual, [], vertexLayout, [], "stencil reader"],
    ["createRenderPipelineWith", h(44), 0, h(2), "vs", h(2), "red", colorTarget(C.FORMAT_BGRA8UNORM), [], [], [], vertexLayout, [], "canvas red"],
    ["createQuerySet", h(45), C.QUERY_TYPE_OCCLUSION, 1, "occlusion"],
    ...(timestamps ? [["createQuerySet", h(46), C.QUERY_TYPE_TIMESTAMP, 4, "timestamps"]] : []),
    ["createBuffer", h(50), 256, READBACK, false, "data readback"],
    ["createBuffer", h(51), 1024, READBACK, false, "target readback"],
    ["createBuffer", h(52), 1024, READBACK, false, "staged readback"],
    ["createBuffer", h(53), 512, READBACK, false, "query readback"],
    ["createBuffer", h(54), 256, READBACK, false, "cleared readback"],
  ], { uploads });
  assert.deepEqual([10, 11, 12, 13, 14, 15].map((id) => d.terminal(id)[0]?.status), [S.OK, S.OK, S.OK, S.OK, S.OK, S.OK], JSON.stringify(d.events));
  const ts = (begin, end) => timestamps ? [h(46), begin, end] : [0, 0, 0];
  await run([
    ["createCommandEncoder", h(60), "frame"],
    ["beginComputePass", h(61), h(60), ...ts(2, 3), "compute"],
    ["computeSetPipeline", h(61), h(21)], ["computeSetBindGroup", h(61), 0, h(20), []], ["computeDispatch", h(61), 1, 1, 1],
    ["computeSetPipeline", h(61), h(22)], ["computeDispatchIndirect", h(61), h(11), 0],
    ["computeSetPipeline", h(61), h(23)], ["computeDispatch", h(61), 1, 1, 1],
    ["computeSetPipeline", h(61), h(24)], ["computeDispatch", h(61), 1, 1, 1],
    ["endComputePass", h(61)],
    ["copyTextureToTexture", h(60), h(30), 0, 0, 0, 0, h(31), 0, 0, 0, 0, 4, 4, 1],
    ["copyBufferToTexture", h(60), h(14), 0, 256, 4, h(32), 0, 0, 0, 0, C.ASPECT_ALL, 4, 4, 1],
    ["beginRenderPass", h(62), h(60), h(36), 0, C.LOAD_CLEAR, C.STORE_STORE, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, "legacy pass"],
    ["renderSetViewport", h(62), 0, 0, 4, 4, 0, 1], ["renderSetScissor", h(62), 0, 0, 4, 4],
    ["renderSetPipeline", h(62), h(40)], ["renderSetBindGroup", h(62), 0, h(39), []],
    ["renderSetVertexBuffer", h(62), 0, h(17), 0, 0], ["renderDraw", h(62), 6, 1, 0, 0], ["renderDrawIndirect", h(62), h(12), 0],
    ["renderSetPipeline", h(62), h(41)], ["renderSetVertexBuffer", h(62), 0, h(15), 0, 32], ["renderSetIndexBuffer", h(62), h(16), C.INDEX_UINT16, 0, 0],
    ["renderDrawIndexed", h(62), 6, 1, 0, 0, 0],
    ["endRenderPass", h(62)],
    ["beginRenderPassWith", h(63), h(60), colorAttachment(h(36), C.LOAD_LOAD, C.STORE_STORE), [h(38), C.LOAD_CLEAR, C.STORE_STORE, 1, 0, C.LOAD_CLEAR, C.STORE_STORE, 0, 0], h(45), ...ts(0, 1), "stencil pass"],
    ["renderSetPipeline", h(63), h(42)], ["renderSetStencilReference", h(63), 1], ["renderSetBlendConstant", h(63), 0, 1, 0, 1],
    ["renderSetVertexBuffer", h(63), 0, h(15), 0, 0], ["renderSetIndexBuffer", h(63), h(16), C.INDEX_UINT16, 0, 12], ["renderDrawIndexed", h(63), 6, 1, 0, 0, 0],
    ["renderSetPipeline", h(63), h(43)], ["renderSetBindGroup", h(63), 0, h(39), []], ["renderSetScissor", h(63), 0, 0, 2, 4],
    ["renderBeginOcclusionQuery", h(63), 0], ["renderDrawIndexedIndirect", h(63), h(13), 0], ["renderEndOcclusionQuery", h(63)],
    ["endRenderPass", h(63)],
    ["copyTextureToBuffer", h(60), h(35), 0, 0, 0, 0, C.ASPECT_ALL, h(51), 0, 256, 4, 4, 4, 1],
    ["copyTextureToBuffer", h(60), h(32), 0, 0, 0, 0, C.ASPECT_ALL, h(52), 0, 256, 0, 4, 4, 1],
    ["resolveQuerySet", h(60), h(45), 0, 1, h(19), 0],
    ...(timestamps ? [["resolveQuerySet", h(60), h(46), 0, 4, h(19), 256]] : []),
    ["clearBuffer", h(60), h(18), 64, 64],
    ["copyBufferToBuffer", h(60), h(18), 0, h(54), 0, 256],
    ["copyBufferToBuffer", h(60), h(10), 0, h(50), 0, 256],
    ["copyBufferToBuffer", h(60), h(19), 0, h(53), 0, 512],
    ["finishCommandEncoder", h(64), h(60), "frame commands"],
    ["queueSubmit", [h(64)]],
    ["mapAsync", 20, h(50), C.MAP_MODE_READ, 0, 256, { offset: 0, length: 256 }],
    ["mapAsync", 21, h(51), C.MAP_MODE_READ, 0, 1024, { offset: 256, length: 1024 }],
    ["mapAsync", 22, h(52), C.MAP_MODE_READ, 0, 1024, { offset: 1280, length: 1024 }],
    ["mapAsync", 23, h(53), C.MAP_MODE_READ, 0, 512, { offset: 2304, length: 512 }],
    ["mapAsync", 24, h(54), C.MAP_MODE_READ, 0, 256, { offset: 2816, length: 256 }],
    ["onSubmittedWorkDone", 25],
    ["destroy", h(61)], ["destroy", h(62)], ["destroy", h(63)], ["release", h(60)], ["release", h(64)],
  ]);
  assert.equal((await d.wait()).wait, "idle");
  for (const id of [20, 21, 22, 23, 24]) assert.equal(d.terminal(id)[0].status, S.OK, JSON.stringify(d.terminal(id)));
  assert.equal(d.terminal(25)[0].type, E.WORK_DONE);
  const data = d.terminal(20)[0].payload.data;
  for (let i = 0; i < 64; i++) assert.equal(data.readUInt32LE(i * 4), 6 * i + 16, `compute word ${i}`);
  const target = d.terminal(21)[0].payload.data;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const pixel = [...target.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4)];
    assert.deepEqual(pixel, x < 2 ? [40 * x + 10, 40 * y + 20, 7, 255] : [0, 255, 0, 255], `target pixel ${x},${y}`);
  }
  const stagedOut = d.terminal(22)[0].payload.data;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) assert.deepEqual([...stagedOut.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4)], [1, 2, 3, 4]);
  const queries = d.terminal(23)[0].payload.data;
  assert.ok(queries.readBigUInt64LE(0) > 0n, "occlusion samples");
  // WebGPU gives no ordering guarantee for timestamps (Metal on Apple GPUs reorders render-pass ones); they resolve.
  if (timestamps) console.log(`timestamps ${[0, 1, 2, 3].map((i) => queries.readBigUInt64LE(256 + i * 8)).join(" ")}`);
  const cleared = d.terminal(24)[0].payload.data;
  for (let i = 0; i < 256; i++) assert.equal(cleared[i], i >= 64 && i < 128 ? 0 : 0xab, `cleared byte ${i}`);

  // Canvas: headless current texture (bgra8unorm), red top half over a blue clear; explicit RGBA capture.
  await run([
    ["configureCanvas", "", C.TEXTURE_USAGE_RENDER_ATTACHMENT, 0, 0],
    ["getCurrentTexture", h(70)],
    ["createTextureView", h(71), h(70), "", 0, 0, 0, 0, 0, C.ASPECT_ALL, "canvas view"],
    ["createCommandEncoder", h(72), "canvas"],
    ["beginRenderPassWith", h(73), h(72), colorAttachment(h(71), C.LOAD_CLEAR, C.STORE_STORE, [0, 0, 1, 1]), [], 0, 0, 0, 0, "canvas pass"],
    ["renderSetPipeline", h(73), h(44)], ["renderSetVertexBuffer", h(73), 0, h(15), 0, 0], ["renderSetIndexBuffer", h(73), h(16), C.INDEX_UINT16, 0, 0],
    ["renderSetScissor", h(73), 0, 0, 8, 4], ["renderDrawIndexed", h(73), 6, 1, 0, 0, 0],
    ["endRenderPass", h(73)],
    ["finishCommandEncoder", h(74), h(72), "canvas commands"],
    ["queueSubmit", [h(74)]],
    ["requestFrame"], ["requestFrame"],
    ["destroy", h(73)], ["destroy", h(72)], ["destroy", h(74)], ["release", h(71)], ["destroy", h(70)],
  ]);
  assert.equal(d.frames, 1, "requestFrame coalesces within a submission");
  const capture = await d.capture();
  assert.equal(capture.capture, 1, JSON.stringify(capture));
  assert.deepEqual([capture.width, capture.height], [8, 8]);
  const rgba = Buffer.from(capture.rgba, "base64");
  assert.deepEqual([...rgba.subarray(0, 4)], [255, 0, 0, 255], "top-left is red in RGBA order");
  assert.deepEqual([...rgba.subarray(7 * 32 + 7 * 4, 7 * 32 + 8 * 4)], [0, 0, 255, 255], "bottom-right is blue");
  // Resize: one RESIZE per distinct size; the next current texture has the new size.
  await d.resize(6, 2, 3);
  await d.resize(6, 2, 3);
  assert.deepEqual(d.events.filter((event) => event.type === E.RESIZE).map((event) => [event.width, event.height, event.dpr]), [[8, 8, 2], [6, 2, 3]]);
  await run([
    ["getCurrentTexture", h(75)], ["createTextureView", h(76), h(75), "", 0, 0, 0, 0, 0, C.ASPECT_ALL, "v"], ["createCommandEncoder", h(77), "e"],
    ["beginRenderPassWith", h(78), h(77), colorAttachment(h(76), C.LOAD_CLEAR, C.STORE_STORE, [0, 1, 0, 1]), [], 0, 0, 0, 0, "p"], ["endRenderPass", h(78)],
    ["finishCommandEncoder", h(79), h(77), "c"], ["queueSubmit", [h(79)]],
  ]);
  const resized = await d.capture();
  assert.deepEqual([resized.width, resized.height], [6, 2]);
  assert.deepEqual([...Buffer.from(resized.rgba, "base64").subarray(0, 4)], [0, 255, 0, 255]);
  // Cancellation and device teardown/restart complete the operation set.
  await run([["mapAsync", 90, h(50), C.MAP_MODE_READ, 0, 256, { offset: 0, length: 256 }], ["cancelRequest", 90], ["destroyDevice"], ["requestDeviceWith", 91, C.POWER_HIGH_PERFORMANCE, 0, 0, []]]);
  assert.equal(d.terminal(90)[0].status, S.CANCELLED);
  assert.equal(d.terminal(91)[0].status, S.OK);
  assert.deepEqual(quiet(d), [], "no protocol or WebGPU errors");
  const all = new Set(JSON.parse(readFileSync(join(here, "../ops.json"), "utf8")).ops.filter((op) => !op.header).map((op) => op.name.toLowerCase().replace(/_([a-z])/g, (_m, c) => c.toUpperCase())));
  assert.equal(all.size, 64);
  assert.deepEqual([...all].filter((name) => !used.has(name)), [], "operations not executed");
});

test("shader compilation info carries Naga diagnostics with GPUCompilationMessage fields", { skip }, async () => {
  const d = await connected();
  await d.submit([
    ["createShaderModule", h(1), 21, "@compute @workgroup_size(1) fn main() {}", "ok"],
    ["createShaderModule", h(2), 22, "@compute @workgroup_size(1)\nfn main() {\n  let x: u32 = 1.5;\n}", "bad type"],
    ["createShaderModule", h(3), 23, "fn main( {", "bad syntax"],
  ]);
  assert.deepEqual(d.terminal(21)[0], { type: E.SHADER_INFO, requestId: 21, handle: h(1), status: S.OK, messages: [] });
  for (const id of [22, 23]) {
    const [event] = d.terminal(id);
    assert.equal(event.type, E.SHADER_INFO);
    assert.equal(event.status, S.ERROR);
    assert.equal(event.messages.length, 1);
    assert.deepEqual(keys(event.messages[0]), ["message", "type", "lineNum", "linePos", "offset", "length"]);
    assert.equal(event.messages[0].type, "error");
  }
  assert.equal(d.terminal(22)[0].messages[0].lineNum, 3);
  // The invalid module stays allocated; a pipeline from it fails like an invalid WebGPU object.
  await d.submit([["createComputePipelineAsync", h(4), 24, 0, h(2), "main", "from invalid"]]);
  assert.equal(d.terminal(24)[0].type, E.ERROR);
  assert.equal(d.events.filter((event) => event.type === E.UNCAUGHT_ERROR).length, 0);
  // A synchronous creation from the invalid module is a WebGPU validation error, reported as UNCAUGHT_ERROR.
  await d.submit([["createComputePipeline", h(5), 0, h(2), "main", "sync from invalid"]]);
  await d.wait();  // uncaptured errors arrive asynchronously, as GPUDevice "uncapturederror" events do
  const uncaught = d.events.filter((event) => event.type === E.UNCAUGHT_ERROR);
  assert.equal(uncaught.length, 1);
  assert.deepEqual(keys(uncaught[0]), ["type", "requestId", "handle", "status", "message"]);
});

test("command encoders and passes follow the WebGPU recording state machine", { skip }, async () => {
  const d = await connected();
  await d.submit([
    ["createTexture", h(1), 4, 4, 1, 1, 1, C.DIMENSION_2D, "rgba8unorm", C.TEXTURE_USAGE_RENDER_ATTACHMENT, "t"],
    ["createTextureView", h(2), h(1), "", 0, 0, 0, 0, 0, C.ASPECT_ALL, "v"],
    ["createQuerySet", h(3), C.QUERY_TYPE_OCCLUSION, 2, "occlusion"],
  ]);
  const pass = (slot, extra = 0) => ["beginRenderPassWith", h(slot), h(10), colorAttachment(h(2), C.LOAD_CLEAR, C.STORE_STORE), [], extra, 0, 0, 0, "p"];
  const steps = [
    [[["createCommandEncoder", h(10), "e"], pass(11), ["createCommandEncoder", h(12), "e2"], ["finishCommandEncoder", h(13), h(10), "f"]], /open pass/],
    [[["renderDrawIndexed", h(11), 3, 1, 0, 0, 0]], /draw without a render pipeline/],
    [[["renderBeginOcclusionQuery", h(11), 0]], /no occlusion query set/],
    [[["endRenderPass", h(11)], ["endRenderPass", h(11)]], /render pass has ended/],
    [[["destroy", h(11)], pass(14, h(3)), ["renderBeginOcclusionQuery", h(14), 0], ["renderBeginOcclusionQuery", h(14), 1]], /already active/],
    [[["endRenderPass", h(14)]], /still active/],
    [[["renderEndOcclusionQuery", h(14)], ["renderBeginOcclusionQuery", h(14), 0]], /invalid or reused/],
    [[["renderBeginOcclusionQuery", h(14), 2]], /invalid or reused/],
    [[["renderEndOcclusionQuery", h(14)]], /not active/],
    [[["endRenderPass", h(14)], ["finishCommandEncoder", h(15), h(10), "f"], ["beginComputePass", h(16), h(10), 0, 0, 0, "c"]], /has finished/],
    [[["queueSubmit", [h(15), h(15)]]], /listed twice/],
    [[["queueSubmit", [h(15)]], ["queueSubmit", [h(15)]]], /already submitted/],
    [[["beginComputePass", h(17), h(12), h(3), 0, 1, "c"]], /timestamp writes need a timestamp query set/],
    [[["copyTextureToBuffer", h(12), h(1), 0, 0, 0, 0, C.ASPECT_ALL, h(3), 0, 100, 0, 4, 4, 1]], /multiple of 256/],
    [[["clearBuffer", h(12), h(3), 2, 4]], /multiples of 4/],
    [[["createQuerySet", h(18), C.QUERY_TYPE_OCCLUSION, 0, "none"]], /query count/],
    [[["createRenderPipelineWith", h(19), 0, h(20), "vs", 0, "", [C.FORMAT_RGBA8UNORM, 15, 0, 0, 0, 0, 0, 0, 0], [], [], [], [], [], "x"]], /stale GPU handle/],
  ];
  for (const [operations, message] of steps) {
    const before = d.errors().length;
    assert.equal((await d.submit(operations)).submit, 0, JSON.stringify(operations));
    assert.match(d.errors()[before]?.message ?? "", message);
  }
  assert.equal(d.events.filter((event) => event.type === E.UNCAUGHT_ERROR).length, 0);
});

test("descriptor records are validated as the JS host does", { skip }, async () => {
  const d = await connected();
  await d.submit([["createShaderModule", h(1), 1, "@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0.0); }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }", "m"]]);
  const pipeline = (slot, targets, primitive = [], depth = [], multisample = [], layouts = [], constants = [], fragment = h(1)) =>
    ["createRenderPipelineWith", h(slot), 0, h(1), "vs", fragment, "fs", targets, primitive, depth, multisample, layouts, constants, "p"];
  const target = colorTarget(C.FORMAT_RGBA8UNORM);
  const cases = [
    [pipeline(2, [1, 2, 3]), /invalid GPU colorTarget record/],
    [pipeline(2, [C.FORMAT_RGBA8UNORM, 16, 0, 0, 0, 0, 0, 0, 0]), /invalid GPU color write mask/],
    [pipeline(2, [99, 15, 0, 0, 0, 0, 0, 0, 0]), /unsupported GPU enum 99/],
    [pipeline(2, target, [...[C.TOPOLOGY_TRIANGLE_LIST, 0, 0, 0, 0], ...[C.TOPOLOGY_TRIANGLE_LIST, 0, 0, 0, 0]]), /accepts at most one record/],
    [pipeline(2, target, [0, 0, 0, 0, 2]), /invalid GPU unclipped depth flag/],
    [pipeline(2, target, [], [0, ...Array(15).fill(0)]), /needs a format/],
    [pipeline(2, target, [], [], [1, 2 ** 32, 0]), /invalid GPU sample mask/],
    [pipeline(2, target, [], [], [], [6, 0, 0]), /multiple of 4/],
    [pipeline(2, target, [], [], [], [8, 0, 1, 0, 0, C.VERTEX_FORMAT_FLOAT32, 8, 0, 1, 0, 0, C.VERTEX_FORMAT_FLOAT32]), /duplicate GPU shader location 0/],
    [pipeline(2, target, [], [], [], [8, 0, 1]), /truncated GPU vertex layout/],
    [pipeline(2, target, [], [], [], [], [8, 1, 0]), /invalid GPU pipeline constant stages/],
    [pipeline(2, target, [], [], [], [], [1, 70000, 0]), /invalid GPU pipeline constant 70000/],
    [pipeline(2, target, [], [], [], [], [1, 3, 1, 3, 3, 2]), /duplicate GPU pipeline constant 3/],
    [pipeline(2, target, [], [], [], [], [], 0), /colour targets need a fragment stage/],
    [["createBindGroupLayout", h(3), bindGroupLayoutEntry(0, 1, 5, 1), "x"], /unsupported GPU binding kind/],
    [["createBindGroupLayout", h(3), bindGroupLayoutEntry(0.5, 1, 1, 1), "x"], /invalid GPU binding/],
    [["createBuffer", h(4), 6, 0, true, "x"], /mapped-at-creation buffer size must be a multiple of 4/],
    [["createBuffer", h(4), -1, 0, false, "x"], /invalid GPU buffer size/],
    [["createRenderPipeline", h(5), 0, h(1), "vs", h(1), "fs", "", "", C.TOPOLOGY_TRIANGLE_LIST, 1, 0, 1, false, 0, 2, [], "x"], /unsupported GPU blend mode/],
  ];
  for (const [operation, message] of cases) {
    const before = d.errors().length;
    assert.equal((await d.submit([operation])).submit, 0, JSON.stringify(operation));
    assert.match(d.errors()[before].message, message);
  }
  assert.equal((await d.submit([pipeline(6, target, [C.TOPOLOGY_TRIANGLE_LIST, 0, C.FRONT_FACE_CW, C.CULL_BACK, 0], [], [1, 0xffffffff, 0])])).submit, 1);
  assert.deepEqual(quiet(d).slice(cases.length), []);
});

test("arenas: uploads up to 512 MiB and readbacks up to 16 MiB; borrowed bytes are consumed during submit", { skip }, async () => {
  const d = await connected();
  assert.equal((await d.claim([["requestFrame"]], 512 * 1024 * 1024 + 1, 0)).submit, 0);
  assert.match(d.errors().at(-1).message, /upload arena/);
  assert.equal((await d.claim([["requestFrame"]], 0, 16 * 1024 * 1024 + 1)).submit, 0);
  assert.match(d.errors().at(-1).message, /readback arena/);
  const size = 16 * 1024 * 1024;
  const big = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4) big.writeUInt32LE((i * 2654435761) >>> 0, i);
  await d.submit([
    ["createBuffer", h(1), size, C.BUFFER_USAGE_COPY_DST | C.BUFFER_USAGE_COPY_SRC, false, "big"],
    ["createBuffer", h(2), size, READBACK, false, "big readback"],
    ["writeBuffer", h(1), 0, { offset: 0, length: size }],
    ["createCommandEncoder", h(3), "e"], ["copyBufferToBuffer", h(3), h(1), 0, h(2), 0, size], ["finishCommandEncoder", h(4), h(3), "c"], ["queueSubmit", [h(4)]],
    ["mapAsync", 5, h(2), C.MAP_MODE_READ, 0, size, { offset: 0, length: size }],
  ], { uploads: big, readback: size });
  assert.equal((await d.wait(30000)).wait, "idle");
  const [event] = d.terminal(5);
  assert.equal(event.status, S.OK);
  assert.equal(event.length, size);
  let hash = 0x811c9dc5;
  for (const byte of big) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  assert.equal(event.payload.hash, hash.toString(16).padStart(8, "0"));
  // Writes past the upload arena or the buffer are refused without touching the device.
  assert.equal((await d.submit([["writeBuffer", h(1), 0, { offset: 8, length: 16 }]], { uploads: Buffer.alloc(16) })).submit, 0);
  assert.match(d.errors().at(-1).message, /outside staging arena/);
  assert.equal((await d.submit([["writeBuffer", h(1), size - 4, { offset: 0, length: 16 }]], { uploads: Buffer.alloc(16) })).submit, 0);
  assert.match(d.errors().at(-1).message, /outside buffer/);
});

test("idle executor: no native polls, no wakes and no events while nothing is pending", { skip }, async () => {
  const d = await connected();
  await d.submit([["createBuffer", h(1), 16, READBACK, false, "b"], ["mapAsync", 2, h(1), C.MAP_MODE_READ, 0, 16, { offset: 0, length: 16 }]]);
  assert.equal((await d.wait()).wait, "idle");
  const first = await d.stats();
  const events = d.events.length;
  await d.sleep(400);
  const second = await d.stats();
  assert.equal(second.polls, first.polls);
  assert.equal(second.wakes, first.wakes);
  assert.equal(d.events.length, events);
  assert.equal(second.pending, 0);
});

test("CAMetalLayer canvas: configure, one current texture per frame, present after submit, reconfigure on resize", { skip }, async () => {
  const d = await start(["--metal-layer", "--width", "32", "--height", "16", "--dpr", "2"]);
  await connect(d, 1);
  const frame = (base) => [
    ["getCurrentTexture", h(base)], ["getCurrentTexture", h(base + 1)],
    ["createTextureView", h(base + 2), h(base), "", 0, 0, 0, 0, 0, C.ASPECT_ALL, "v"],
    ["createCommandEncoder", h(base + 3), "e"],
    ["beginRenderPassWith", h(base + 4), h(base + 3), colorAttachment(h(base + 2), C.LOAD_CLEAR, C.STORE_STORE, [1, 0, 0, 1]), [], 0, 0, 0, 0, "p"],
    ["endRenderPass", h(base + 4)], ["finishCommandEncoder", h(base + 5), h(base + 3), "c"], ["queueSubmit", [h(base + 5)]],
    ...[0, 1, 2, 3, 4, 5].map((i) => ["destroy", h(base + i)]),
  ];
  assert.equal((await d.submit([["getCurrentTexture", h(9)]])).submit, 0);
  assert.match(d.errors().at(-1).message, /canvas not configured/);
  assert.equal((await d.submit([["configureCanvas", "bgra8unorm", C.TEXTURE_USAGE_RENDER_ATTACHMENT, 1, 0], ...frame(10)])).submit, 1);
  assert.equal((await d.submit(frame(20))).submit, 1);
  await d.resize(48, 24, 2);
  assert.equal((await d.submit(frame(30))).submit, 1);
  await d.wait();
  assert.deepEqual(quiet(d).slice(1), [], "no protocol or WebGPU errors");
  const capture = await d.capture();
  assert.equal(capture.capture, 0);
  assert.equal(d.errors().at(-1).capture, true);
  assert.match(d.errors().at(-1).message, /CAMetalLayer/);
  // Device loss releases the surface; the layer stays leased and a restarted device configures a new surface.
  await d.submit([["destroyDevice"]]);
  await connect(d, 2);
  assert.equal((await d.submit([["configureCanvas", "", C.TEXTURE_USAGE_RENDER_ATTACHMENT, 0, 0], ...frame(40)])).submit, 1);
  assert.deepEqual(quiet(d).filter((event) => !event.capture).slice(1), []);
});

test("exactly one terminal event per request id under random cancellation, unmap, destroy and loss", { skip, timeout: 120000 }, async () => {
  const d = await start();
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let id = 100, generation = 1, connected = false, deviceRequest = 0;
  const shader = "@compute @workgroup_size(1) fn main() {}";
  for (let round = 0; round < 60; round++) {
    if (!connected) {
      deviceRequest = id++;
      await d.submit([["requestDeviceWith", deviceRequest, C.POWER_HIGH_PERFORMANCE, 0, 0, []]]);
      assert.equal(d.terminal(deviceRequest)[0]?.status, S.OK);
      connected = true;
    }
    const g = generation++;
    const operations = [["createShaderModule", h(1, g), id++, shader, "m"]];
    for (let slot = 2; slot < 6; slot++) operations.push(["createBuffer", h(slot, g), 256, READBACK, false, "b"]);
    const requests = [];
    for (let slot = 2; slot < 6; slot++) {
      const request = id++;
      requests.push(request);
      operations.push(["mapAsync", request, h(slot, g), C.MAP_MODE_READ, 0, 256, { offset: (slot - 2) * 256, length: 256 }]);
      const choice = random();
      if (choice < 0.2) operations.push(["cancelRequest", request]);
      else if (choice < 0.4) operations.push(["unmap", h(slot, g)]);
      else if (choice < 0.5) operations.push(["destroy", h(slot, g)]);
    }
    const work = id++, pipeline = id++;
    requests.push(work, pipeline);
    operations.push(["onSubmittedWorkDone", work], ["createComputePipelineAsync", h(6, g), pipeline, 0, h(1, g), "main", "p"]);
    if (random() < 0.3) operations.push(["cancelRequest", pipeline]);
    const loss = random();
    if (loss < 0.15) { operations.push(["destroyDevice"]); connected = false; }
    await d.submit(operations);
    if (connected && loss < 0.3) { await d.lose(); connected = false; }
    await d.wait();
    // Retire everything of this generation, lost or not, without errors.
    const errors = d.errors().length;
    await d.submit([1, 2, 3, 4, 5, 6].map((slot) => ["destroy", h(slot, g)]));
    assert.ok(d.errors().slice(errors).every((event) => /stale GPU handle/.test(event.message)), JSON.stringify(d.errors().slice(errors)));
    for (const request of requests) assert.equal(d.terminal(request).length, 1, `request ${request} ${JSON.stringify(d.terminal(request))}`);
  }
  const ids = new Set(d.events.filter((event) => event.requestId).map((event) => event.requestId));
  for (const request of ids) assert.equal(d.terminal(request).length, 1, `request ${request} completed more than once`);
  assert.equal(d.events.filter((event) => event.type === E.UNCAUGHT_ERROR).length, 0, JSON.stringify(d.events.filter((event) => event.type === E.UNCAUGHT_ERROR)));
  assert.equal((await d.stats()).pending, 0);
});

// NTGPU_SHADER_CORPUS=<dir with manifest.json and wgsl/> (the gpu-shaders lane capture) runs every recorded module
// and pipeline shape through the executor. Front-end rejections are reported in the summary, not failed here.
const corpus = process.env.NTGPU_SHADER_CORPUS;
test("captured shader corpus: every module and pipeline shape completes exactly once without device errors", { skip: skip || (!corpus && "NTGPU_SHADER_CORPUS not set"), timeout: 600000 }, () => {
  const out = execFileSync(process.execPath, [join(here, "executor-corpus.mjs"), "--corpus", corpus, "--driver", join(build, "ntgpu-executor-driver"), "--out", join(build, "corpus-report.json")], { encoding: "utf8", maxBuffer: 1 << 26 });
  const report = JSON.parse(readFileSync(join(build, "corpus-report.json"), "utf8"));
  assert.ok(report.modules.every((module) => module.status !== null), out);
  assert.ok(report.pipelines.every((pipeline) => pipeline.status !== "missing"));
  assert.equal(report.summary.uncaughtErrors, 0);
  assert.equal(report.summary.deviceLost, 0);
  console.log(`corpus: ${report.summary.modulesOk}/${report.summary.modules} modules, ${report.summary.pipelinesOk}/${report.summary.pipelines} pipelines`);
});
