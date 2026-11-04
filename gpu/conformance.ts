// Real-GPU conformance reactor. conformance-test.mjs drives the steps in Chrome and checks every
// completion event; this guest verifies the pixels and buffers it reads back.
import * as gpu from "./index.js";
import { setSink, flush, reserveUpload, uploadView, reserveReadback, readbackView, type ReadbackSlice } from "./index.js";

declare function gpuPresent(batch: Uint8Array, uploads: Uint8Array, readbacks: Uint8Array): void;
declare function gpuReport(message: string): void;

const MRT = `
@id(5) override depth: f32 = 2.0;
struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) colour: vec4f,
  @location(1) @interpolate(flat) id: u32,
};
@vertex fn vs(@location(0) position: vec2f, @location(1) colour: vec4f, @location(2) id: u32) -> Varyings {
  var out: Varyings;
  out.position = vec4f(position, depth, 1.0);
  out.colour = colour;
  out.id = id;
  return out;
}
struct Targets { @location(0) colour: vec4f, @location(1) id: u32 };
@fragment fn fs(input: Varyings) -> Targets {
  var out: Targets;
  out.colour = input.colour;
  out.id = input.id;
  return out;
}`;
const FILL = `
@id(3) override factor: u32 = 1u;
@group(0) @binding(0) var<storage, read_write> data: array<u32, 64>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) i: u32) {
  data[i] = i * factor + 1u;
}`;
const READBACK = gpu.BUFFER_USAGE_MAP_READ | gpu.BUFFER_USAGE_COPY_DST;
const SIZES = [1024, 1024, 8, 256, 256];

let live: number[] = [];
let shader = 0;
let fillShader = 0;
let groupLayout = 0;
let computeLayout = 0;
let stencilWriter = 0;
let blendTest = 0;
let constantBlend = 0;
let fill = 0;
let colourView = 0;
let ready = 0;
let verified = 0;
let mapped: number[] = [];
let slices: ReadbackSlice[] = [];
let spare: number[] = [];
let spareSlices: ReadbackSlice[] = [];
let restartBuffer = 0;
let restartSlice: ReadbackSlice = { offset: 0, length: 0 };

function keep(handle: number): number {
  live.push(handle);
  return handle;
}

function fail(what: string): void {
  gpuReport("CONF_FAIL " + what);
}

function buffer(size: number, usage: number, label: string): number {
  return keep(gpu.createBuffer(size, usage, false, label));
}

function upload(target: number, values: number[]): void {
  const slice = reserveUpload(values.length * 4);
  const view = uploadView(slice);
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    view[i * 4] = value & 255;
    view[i * 4 + 1] = (value >>> 8) & 255;
    view[i * 4 + 2] = (value >>> 16) & 255;
    view[i * 4 + 3] = (value >>> 24) & 255;
  }
  gpu.writeBuffer(target, 0, slice);
}

function floatBits(value: number): number {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setFloat32(0, value, true);
  return scratch.getUint32(0, true);
}

function quad(x0: number, x1: number): number[] {
  return [floatBits(x0), floatBits(-1), floatBits(x1), floatBits(-1), floatBits(x0), floatBits(1), floatBits(x1), floatBits(1)];
}

function stencilState(depthWrite: number, depthCompare: number, compare: number, pass: number): number[] {
  return gpu.recordDepthStencil([], gpu.FORMAT_DEPTH24PLUS_STENCIL8, depthWrite, depthCompare, compare, gpu.STENCIL_OP_KEEP, gpu.STENCIL_OP_KEEP, pass, compare, gpu.STENCIL_OP_KEEP, gpu.STENCIL_OP_KEEP, pass, 255, 255, 0, 0, 0);
}

// Vertex buffer 0: float32x2 positions per vertex. Buffer 1: unorm8x4 colour and uint32 id per instance.
function pipeline(requestId: number, targets: number[], depthState: number[]): number {
  const vertex = [8, gpu.STEP_VERTEX, 1, 0, 0, gpu.VERTEX_FORMAT_FLOAT32X2, 8, gpu.STEP_INSTANCE, 2, 1, 0, gpu.VERTEX_FORMAT_UNORM8X4, 2, 4, gpu.VERTEX_FORMAT_UINT32];
  const primitive = gpu.recordPrimitive([], gpu.TOPOLOGY_TRIANGLE_LIST, 0, gpu.FRONT_FACE_CCW, gpu.CULL_NONE, 0);
  const constants = gpu.recordConstant([], gpu.SHADER_STAGE_VERTEX, 5, 0.5);
  return keep(gpu.createRenderPipelineAsyncWith(requestId, 0, shader, "vs", shader, "fs", targets, primitive, depthState, [], vertex, constants, "conformance pipeline"));
}

function setup(): void {
  shader = keep(gpu.createShaderModule(10, MRT, "mrt"));
  fillShader = keep(gpu.createShaderModule(11, FILL, "fill"));
  // Stencil writer: no colour writes; stencil becomes the reference value.
  const silent: number[] = [];
  gpu.recordColorTarget(silent, gpu.FORMAT_RGBA8UNORM, 0, 0, 0, 0, 0, 0, 0, 0);
  gpu.recordColorTarget(silent, gpu.FORMAT_R32UINT, 0, 0, 0, 0, 0, 0, 0, 0);
  stencilWriter = pipeline(12, silent, stencilState(0, gpu.COMPARE_ALWAYS, gpu.COMPARE_ALWAYS, gpu.STENCIL_OP_REPLACE));
  // Source-alpha blending into target 0 and integer ids into target 1 where stencil equals the reference.
  const blended: number[] = [];
  gpu.recordColorTarget(blended, gpu.FORMAT_RGBA8UNORM, gpu.COLOR_WRITE_ALL, 1, gpu.BLEND_OP_ADD, gpu.BLEND_FACTOR_SRC_ALPHA, gpu.BLEND_FACTOR_ONE_MINUS_SRC_ALPHA, gpu.BLEND_OP_ADD, gpu.BLEND_FACTOR_ONE, gpu.BLEND_FACTOR_ONE_MINUS_SRC_ALPHA);
  gpu.recordColorTarget(blended, gpu.FORMAT_R32UINT, gpu.COLOR_WRITE_ALL, 0, 0, 0, 0, 0, 0, 0);
  blendTest = pipeline(13, blended, stencilState(1, gpu.COMPARE_LESS, gpu.COMPARE_EQUAL, gpu.STENCIL_OP_KEEP));
  // Blend-constant colour into target 0; the id target is masked off.
  const constant: number[] = [];
  gpu.recordColorTarget(constant, gpu.FORMAT_RGBA8UNORM, gpu.COLOR_WRITE_ALL, 1, gpu.BLEND_OP_ADD, gpu.BLEND_FACTOR_CONSTANT, gpu.BLEND_FACTOR_ZERO, gpu.BLEND_OP_ADD, gpu.BLEND_FACTOR_ONE, gpu.BLEND_FACTOR_ZERO);
  gpu.recordColorTarget(constant, gpu.FORMAT_R32UINT, 0, 0, 0, 0, 0, 0, 0, 0);
  constantBlend = pipeline(14, constant, stencilState(0, gpu.COMPARE_ALWAYS, gpu.COMPARE_EQUAL, gpu.STENCIL_OP_KEEP));
  groupLayout = keep(gpu.createBindGroupLayout(gpu.recordBindGroupLayout([], 0, gpu.SHADER_STAGE_COMPUTE, gpu.BINDING_BUFFER, gpu.BUFFER_BINDING_STORAGE, 0, 256, 0, 0, 0, 0), "fill bindings"));
  computeLayout = keep(gpu.createPipelineLayout([groupLayout], "fill layout"));
  fill = keep(gpu.createComputePipelineAsyncWith(15, computeLayout, fillShader, "main", gpu.recordConstant([], gpu.SHADER_STAGE_COMPUTE, 3, 5), "fill"));
  flush();
}

// One submission: MRT render pass with stencil, blending and an occlusion query, texture readback,
// clearBuffer, an override-constant compute dispatch, then five maps into the readback arena.
function renderAndRead(): void {
  const attachment = gpu.TEXTURE_USAGE_RENDER_ATTACHMENT | gpu.TEXTURE_USAGE_COPY_SRC;
  const colourTexture = keep(gpu.createTexture(4, 4, 1, 1, 1, gpu.DIMENSION_2D, "rgba8unorm", attachment, "colour"));
  const idTexture = keep(gpu.createTexture(4, 4, 1, 1, 1, gpu.DIMENSION_2D, "r32uint", attachment, "ids"));
  const depthTexture = keep(gpu.createTexture(4, 4, 1, 1, 1, gpu.DIMENSION_2D, "depth24plus-stencil8", gpu.TEXTURE_USAGE_RENDER_ATTACHMENT, "depth stencil"));
  colourView = keep(gpu.createTextureView(colourTexture, "", 0, 0, 0, 0, 0, 0, "colour view"));
  const idView = keep(gpu.createTextureView(idTexture, "", 0, 0, 0, 0, 0, 0, "id view"));
  const depthView = keep(gpu.createTextureView(depthTexture, "", 0, 0, 0, 0, 0, 0, "depth view"));
  const vertexUsage = gpu.BUFFER_USAGE_VERTEX | gpu.BUFFER_USAGE_COPY_DST;
  const left = buffer(32, vertexUsage, "left quad");
  const full = buffer(32, vertexUsage, "full quad");
  const instances = buffer(16, vertexUsage, "instances");
  const indices = buffer(12, gpu.BUFFER_USAGE_INDEX | gpu.BUFFER_USAGE_COPY_DST, "indices");
  upload(left, quad(-1, 0));
  upload(full, quad(-1, 1));
  // Instance 0: red at alpha 128/255 with id 7. Instance 1: opaque white with id 9.
  upload(instances, [0x800000ff, 7, 0xffffffff, 9]);
  // uint16 indices 0 1 2, 2 1 3.
  upload(indices, [0x00010000, 0x00020002, 0x00030001]);
  const occlusion = keep(gpu.createQuerySet(gpu.QUERY_TYPE_OCCLUSION, 1, "occlusion"));
  const resolve = buffer(256, gpu.BUFFER_USAGE_QUERY_RESOLVE | gpu.BUFFER_USAGE_COPY_SRC, "occlusion resolve");
  const cleared = buffer(256, gpu.BUFFER_USAGE_COPY_DST | gpu.BUFFER_USAGE_COPY_SRC, "cleared");
  const pattern: number[] = [];
  for (let i = 0; i < 64; i++) pattern.push(0xabababab);
  upload(cleared, pattern);
  const storage = buffer(256, gpu.BUFFER_USAGE_STORAGE | gpu.BUFFER_USAGE_COPY_SRC, "fill output");
  const group = keep(gpu.createBindGroup(groupLayout, [0, gpu.BINDING_BUFFER, storage, 0, 256], "fill group"));
  mapped = [];
  slices = [];
  for (let i = 0; i < SIZES.length; i++) {
    mapped.push(buffer(SIZES[i]!, READBACK, "readback"));
    slices.push(reserveReadback(SIZES[i]!));
  }

  const encoder = gpu.createCommandEncoder("conformance");
  const colours: number[] = [];
  gpu.recordColorAttachment(colours, colourView, 0, gpu.LOAD_CLEAR, gpu.STORE_STORE, 0, 0, 1, 1, 0);
  gpu.recordColorAttachment(colours, idView, 0, gpu.LOAD_CLEAR, gpu.STORE_STORE, 0, 0, 0, 0, 0);
  const depth = gpu.recordDepthStencilAttachment([], depthView, gpu.LOAD_CLEAR, gpu.STORE_STORE, 1, 0, gpu.LOAD_CLEAR, gpu.STORE_STORE, 0, 0);
  const pass = gpu.beginRenderPassWith(encoder, colours, depth, occlusion, 0, 0, 0, "mrt");
  gpu.renderSetVertexBuffer(pass, 1, instances, 0, 0);
  gpu.renderSetIndexBuffer(pass, indices, gpu.INDEX_UINT16, 0, 12);
  gpu.renderSetPipeline(pass, stencilWriter);
  gpu.renderSetVertexBuffer(pass, 0, left, 0, 0);
  gpu.renderSetStencilReference(pass, 1);
  gpu.renderDrawIndexed(pass, 6, 1, 0, 0, 0);
  gpu.renderSetPipeline(pass, blendTest);
  gpu.renderSetVertexBuffer(pass, 0, full, 0, 0);
  gpu.renderBeginOcclusionQuery(pass, 0);
  gpu.renderDrawIndexed(pass, 6, 1, 0, 0, 0);
  gpu.renderEndOcclusionQuery(pass);
  gpu.renderSetPipeline(pass, constantBlend);
  gpu.renderSetStencilReference(pass, 0);
  gpu.renderSetBlendConstant(pass, 0, 1, 0, 1);
  gpu.renderDrawIndexed(pass, 6, 1, 0, 0, 1);
  gpu.endRenderPass(pass);
  gpu.copyTextureToBuffer(encoder, colourTexture, 0, 0, 0, 0, gpu.ASPECT_ALL, mapped[0]!, 0, 256, 4, 4, 4, 1);
  gpu.copyTextureToBuffer(encoder, idTexture, 0, 0, 0, 0, gpu.ASPECT_ALL, mapped[1]!, 0, 256, 4, 4, 4, 1);
  gpu.resolveQuerySet(encoder, occlusion, 0, 1, resolve, 0);
  gpu.copyBufferToBuffer(encoder, resolve, 0, mapped[2]!, 0, 8);
  gpu.clearBuffer(encoder, cleared, 64, 64);
  gpu.copyBufferToBuffer(encoder, cleared, 0, mapped[3]!, 0, 256);
  const compute = gpu.beginComputePass(encoder, 0, 0, 0, "fill");
  gpu.computeSetPipeline(compute, fill);
  gpu.computeSetBindGroup(compute, 0, group, []);
  gpu.computeDispatch(compute, 1, 1, 1);
  gpu.endComputePass(compute);
  gpu.copyBufferToBuffer(encoder, storage, 0, mapped[4]!, 0, 256);
  const commands = gpu.finishCommandEncoder(encoder, "conformance commands");
  gpu.queueSubmit([commands]);
  for (let i = 0; i < SIZES.length; i++) gpu.mapAsync(30 + i, mapped[i]!, gpu.MAP_MODE_READ, 0, SIZES[i]!, slices[i]!);
  gpu.destroy(pass);
  gpu.destroy(compute);
  gpu.destroy(encoder);
  gpu.destroy(commands);
  flush();
}

function verifyRender(): void {
  const colour = readbackView(slices[0]!);
  const idBytes = readbackView(slices[1]!);
  const ids = new DataView(idBytes.buffer, idBytes.byteOffset, 1024);
  let bad = 0;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const at = y * 256 + x * 4;
      const r = colour[at]!, g = colour[at + 1]!, b = colour[at + 2]!, a = colour[at + 3]!;
      const id = ids.getUint32(at, true);
      const pixel = x + "," + y + " " + r + "/" + g + "/" + b + "/" + a + " id " + id;
      if (x < 2) {
        if (Math.abs(r - 128) > 1 || g !== 0 || Math.abs(b - 127) > 1 || a !== 255 || id !== 7) { bad++; fail("left pixel " + pixel); }
      } else if (r !== 0 || g !== 255 || b !== 0 || a !== 255 || id !== 0) { bad++; fail("right pixel " + pixel); }
    }
  }
  const queryBytes = readbackView(slices[2]!);
  const query = new DataView(queryBytes.buffer, queryBytes.byteOffset, 8);
  const samples = query.getUint32(0, true) + query.getUint32(4, true) * 4294967296;
  if (samples === 0) { bad++; fail("occlusion query counted no samples"); }
  const cleared = readbackView(slices[3]!);
  for (let i = 0; i < 256; i++) {
    const expected = i >= 64 && i < 128 ? 0 : 0xab;
    if (cleared[i] !== expected) { bad++; fail("clearBuffer byte " + i); break; }
  }
  const filledBytes = readbackView(slices[4]!);
  const filled = new DataView(filledBytes.buffer, filledBytes.byteOffset, 256);
  for (let i = 0; i < 64; i++) {
    if (filled.getUint32(i * 4, true) !== i * 5 + 1) { bad++; fail("override constant word " + i); break; }
  }
  gpuReport(bad === 0 ? "CONF_RENDER_OK " + samples : "CONF_RENDER_FAILED " + bad);
}

// Protocol state rejections: each batch is refused at the invalid operation; the request after it
// completes as CANCELLED and the trailing destroys still run.
function stateRejections(): void {
  const encoder = gpu.createCommandEncoder("ended pass");
  const compute = gpu.beginComputePass(encoder, 0, 0, 0, "ended");
  gpu.computeSetPipeline(compute, fill);
  gpu.endComputePass(compute);
  gpu.computeDispatch(compute, 1, 1, 1);
  gpu.onSubmittedWorkDone(40);
  gpu.destroy(compute);
  gpu.destroy(encoder);
  flush();
  const second = gpu.createCommandEncoder("double submit");
  const commands = gpu.finishCommandEncoder(second, "submitted once");
  gpu.queueSubmit([commands]);
  gpu.queueSubmit([commands]);
  gpu.onSubmittedWorkDone(41);
  gpu.destroy(commands);
  gpu.destroy(second);
  flush();
  const third = gpu.createCommandEncoder("no pipeline");
  const pass = gpu.beginRenderPassWith(third, gpu.recordColorAttachment([], colourView, 0, gpu.LOAD_LOAD, gpu.STORE_STORE, 0, 0, 0, 0, 0), [], 0, 0, 0, 0, "no pipeline");
  gpu.renderDraw(pass, 3, 1, 0, 0);
  gpu.onSubmittedWorkDone(42);
  gpu.destroy(pass);
  gpu.destroy(third);
  flush();
  // Slots retired above are reused with the next generation; the host must accept them.
  const reused = gpu.createBuffer(16, gpu.BUFFER_USAGE_COPY_DST, false, "reused slot");
  gpu.destroy(reused);
  gpu.onSubmittedWorkDone(43);
  flush();
}

function cancellations(): void {
  spare = [];
  spareSlices = [];
  for (let i = 0; i < 4; i++) {
    spare.push(buffer(256, READBACK, "spare"));
    spareSlices.push(reserveReadback(256));
  }
  gpu.mapAsync(50, spare[0]!, gpu.MAP_MODE_READ, 0, 256, spareSlices[0]!);
  gpu.cancelRequest(50);
  gpu.mapAsync(51, spare[0]!, gpu.MAP_MODE_READ, 0, 256, spareSlices[0]!);
  gpu.mapAsync(52, spare[1]!, gpu.MAP_MODE_READ, 0, 256, spareSlices[1]!);
  gpu.unmap(spare[1]!);
  const cancelled = pipeline(53, [gpu.FORMAT_RGBA8UNORM, gpu.COLOR_WRITE_ALL, 0, 0, 0, 0, 0, 0, 0, gpu.FORMAT_R32UINT, gpu.COLOR_WRITE_ALL, 0, 0, 0, 0, 0, 0, 0], []);
  gpu.cancelRequest(53);
  gpu.destroy(cancelled);
  live = live.filter((value: number) => value !== cancelled);
  flush();
  gpu.mapAsync(55, spare[2]!, gpu.MAP_MODE_READ, 0, 256, spareSlices[2]!);
  gpu.mapAsync(56, spare[3]!, gpu.MAP_MODE_READ, 0, 256, spareSlices[2]!);
  flush();
  gpu.onSubmittedWorkDone(54);
  gpu.onSubmittedWorkDone(54);
  flush();
}

function loseWithPending(): void {
  gpu.mapAsync(70, spare[0]!, gpu.MAP_MODE_READ, 0, 256, spareSlices[0]!);
  gpu.onSubmittedWorkDone(71);
  keep(gpu.createComputePipelineAsyncWith(72, computeLayout, fillShader, "main", gpu.recordConstant([], gpu.SHADER_STAGE_COMPUTE, 3, 2), "lost"));
  gpu.destroyDevice();
  flush();
}

function restart(): void {
  // Every handle of the lost device is retired without errors before the new device is requested.
  for (let i = 0; i < live.length; i++) gpu.destroy(live[i]!);
  live = [];
  gpu.requestDeviceWith(73, gpu.POWER_HIGH_PERFORMANCE, 0, 0, []);
  flush();
}

function restarted(): void {
  const texture = keep(gpu.createTexture(4, 4, 1, 1, 1, gpu.DIMENSION_2D, "rgba8unorm", gpu.TEXTURE_USAGE_RENDER_ATTACHMENT | gpu.TEXTURE_USAGE_COPY_SRC, "restart"));
  const view = keep(gpu.createTextureView(texture, "", 0, 0, 0, 0, 0, 0, "restart view"));
  restartBuffer = buffer(1024, READBACK, "restart readback");
  if (restartSlice.length === 0) restartSlice = reserveReadback(1024);
  const encoder = gpu.createCommandEncoder("restart");
  const pass = gpu.beginRenderPassWith(encoder, gpu.recordColorAttachment([], view, 0, gpu.LOAD_CLEAR, gpu.STORE_STORE, 0, 1, 0, 1, 0), [], 0, 0, 0, 0, "restart clear");
  gpu.endRenderPass(pass);
  gpu.copyTextureToBuffer(encoder, texture, 0, 0, 0, 0, gpu.ASPECT_ALL, restartBuffer, 0, 256, 4, 4, 4, 1);
  const commands = gpu.finishCommandEncoder(encoder, "restart commands");
  gpu.queueSubmit([commands]);
  gpu.mapAsync(74, restartBuffer, gpu.MAP_MODE_READ, 0, 1024, restartSlice);
  gpu.destroy(pass);
  gpu.destroy(encoder);
  gpu.destroy(commands);
  flush();
}

function pendingForExternalLoss(): void {
  gpu.mapAsync(80, restartBuffer, gpu.MAP_MODE_READ, 0, 1024, restartSlice);
  gpu.onSubmittedWorkDone(81);
  flush();
}

export function start(): number {
  setSink((batch: Uint8Array, uploads: Uint8Array, readbacks: Uint8Array) => {
    gpuPresent(batch, uploads, readbacks);
  });
  // A requirement the adapter cannot meet is reported as a capability result.
  gpu.requestDeviceWith(1, gpu.POWER_HIGH_PERFORMANCE, 0, 0, gpu.recordLimitRequest([], gpu.LIMIT_MAX_BIND_GROUPS, 1000000, gpu.LIMIT_MODE_REQUIRED));
  flush();
  return 0;
}

export function event(type: number, requestId: number, handle: number, status: number, value: number, text: string): number {
  if (type === gpu.GPU_EVENT_CAPABILITIES && requestId === 1) {
    if (status === gpu.GPU_STATUS_OK) fail("an impossible limit was granted");
    const limits: number[] = [];
    gpu.recordLimitRequest(limits, gpu.LIMIT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE, 10, gpu.LIMIT_MODE_PREFERRED);
    gpu.recordLimitRequest(limits, gpu.LIMIT_MAX_COLOR_ATTACHMENTS, 4, gpu.LIMIT_MODE_REQUIRED);
    gpu.requestDeviceWith(2, gpu.POWER_HIGH_PERFORMANCE, 0, gpu.FEATURE_TIMESTAMP_QUERY, limits);
    flush();
  } else if (type === gpu.GPU_EVENT_CAPABILITIES && requestId === 2) {
    if (status !== gpu.GPU_STATUS_OK) { fail("device negotiation " + text); return 0; }
    gpuReport("CONF_DEVICE " + value);
    setup();
  } else if (type === gpu.GPU_EVENT_PIPELINE_READY && requestId >= 12 && requestId <= 15) {
    if (status !== gpu.GPU_STATUS_OK) { fail("pipeline " + requestId + " " + text); return 0; }
    ready++;
    if (ready === 4) gpuReport("CONF_READY");
  } else if (type === gpu.GPU_EVENT_MAP_READY && requestId >= 30 && requestId <= 34) {
    if (status !== gpu.GPU_STATUS_OK) { fail("readback " + requestId + " " + text); return 0; }
    verified++;
    if (verified === SIZES.length) verifyRender();
  } else if (type === gpu.GPU_EVENT_DEVICE_LOST) {
    gpuReport("CONF_LOST " + handle);
  } else if (type === gpu.GPU_EVENT_CAPABILITIES && requestId === 73) {
    if (status !== gpu.GPU_STATUS_OK) { fail("restart " + text); return 0; }
    restarted();
  } else if (type === gpu.GPU_EVENT_MAP_READY && requestId === 74) {
    const bytes = readbackView(restartSlice);
    let bad = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const at = y * 256 + x * 4;
        if (bytes[at] !== 0 || bytes[at + 1] !== 255 || bytes[at + 2] !== 0 || bytes[at + 3] !== 255) bad++;
      }
    }
    gpuReport(status === gpu.GPU_STATUS_OK && bad === 0 ? "CONF_RESTART_OK" : "CONF_RESTART_FAILED " + status + " " + bad);
  } else if (type === gpu.GPU_EVENT_SHADER_INFO && status !== gpu.GPU_STATUS_OK) {
    fail("shader " + requestId + " " + text);
  }
  return 0;
}

export function step(phase: number): number {
  if (phase === 1) renderAndRead();
  else if (phase === 2) stateRejections();
  else if (phase === 3) cancellations();
  else if (phase === 4) loseWithPending();
  else if (phase === 5) restart();
  else if (phase === 6) pendingForExternalLoss();
  return 0;
}

export function frame(_timeMs: number): number {
  return 0;
}

export function message(_kind: number, _payload: Uint8Array): number {
  return 0;
}

export function readback(offset: number, bytes: Uint8Array): number { return gpu.writeReadback(offset, bytes); }
