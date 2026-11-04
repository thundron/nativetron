import * as gpu from "./index.js";
import {
  setSink, flush, reserveUpload, uploadView, reserveReadback, readbackView,
  type ReadbackSlice,
} from "./index.js";

declare function gpuPresent(batch: Uint8Array, uploads: Uint8Array, readbacks: Uint8Array): void;
declare function gpuReport(message: string): void;

const COMPUTE = `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64)
fn fill(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < 1024u) { data[id.x] = id.x * 3u + 7u; }
  if (id.x == 0u) {
    data[1024] = 3u; data[1025] = 1u; data[1026] = 0u; data[1027] = 0u;
    data[1028] = bitcast<u32>(-0.7); data[1029] = bitcast<u32>(-0.6);
    data[1030] = bitcast<u32>(0.7); data[1031] = bitcast<u32>(-0.6);
    data[1032] = bitcast<u32>(0.0); data[1033] = bitcast<u32>(0.7);
  }
}`;
const RENDER = `
@group(0) @binding(0) var<storage, read> data: array<u32>;
@vertex fn vertex(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
  let position = vec2f(bitcast<f32>(data[1028u + id * 2u]), bitcast<f32>(data[1029u + id * 2u]));
  return vec4f(position, 0.0, 1.0);
}
@fragment fn fragment() -> @location(0) vec4f {
  return vec4f(f32(data[0]) / 10.0, 0.8, 0.3, 1.0);
}`;

let storage = 0;
let uploadBuffer = 0;
let compute = 0;
let render = 0;
let computeGroup = 0;
let renderGroup = 0;
let readback = 0;
let queries = 0;
let queryBuffer = 0;
let queryReadback = 0;
let pipelinesReady = 0;
let colour = 0.08;
let ready = false;
let firstFrame = true;
let reportColour = false;
let growOnNextFrame = false;
let result: ReadbackSlice = { offset: 0, length: 0 };
let timings: ReadbackSlice = { offset: 0, length: 0 };

export function start(): number {
  setSink((batch: Uint8Array, uploads: Uint8Array, readbacks: Uint8Array) => {
    gpuPresent(batch, uploads, readbacks);
  });
  gpu.requestDevice(1, 1, gpu.FEATURE_TIMESTAMP_QUERY, 0);
  flush();
  return 0;
}

interface DemoCapabilities { format: string; }

function setup(timestamp: boolean, format: string): void {
  gpu.configureCanvas(format, gpu.TEXTURE_USAGE_RENDER_ATTACHMENT, 0, 0);
  storage = gpu.createBuffer(8192, gpu.BUFFER_USAGE_STORAGE | gpu.BUFFER_USAGE_INDIRECT | gpu.BUFFER_USAGE_COPY_SRC | gpu.BUFFER_USAGE_COPY_DST, false, "compute output + indirect arguments");
  readback = gpu.createBuffer(4096, gpu.BUFFER_USAGE_MAP_READ | gpu.BUFFER_USAGE_COPY_DST, false, "readback");
  result = reserveReadback(4096);
  uploadBuffer = gpu.createBuffer(16777216, gpu.BUFFER_USAGE_COPY_DST | gpu.BUFFER_USAGE_COPY_SRC, false, "16 MiB upload");
  const upload = reserveUpload(16777216);
  const bytes = uploadView(upload);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
  gpu.writeBuffer(uploadBuffer, 0, upload);

  const computeShader = gpu.createShaderModule(10, COMPUTE, "fill");
  const renderShader = gpu.createShaderModule(11, RENDER, "triangle");
  const computeBindings = gpu.createBindGroupLayout([0, gpu.SHADER_STAGE_COMPUTE, gpu.BINDING_BUFFER, gpu.BUFFER_BINDING_STORAGE, 0, 8192, 0, 0, 0, 0], "compute bindings");
  const renderBindings = gpu.createBindGroupLayout([0, gpu.SHADER_STAGE_VERTEX | gpu.SHADER_STAGE_FRAGMENT, gpu.BINDING_BUFFER, gpu.BUFFER_BINDING_READ_ONLY_STORAGE, 0, 8192, 0, 0, 0, 0], "render bindings");
  computeGroup = gpu.createBindGroup(computeBindings, [0, gpu.BINDING_BUFFER, storage, 0, 8192], "compute group");
  renderGroup = gpu.createBindGroup(renderBindings, [0, gpu.BINDING_BUFFER, storage, 0, 8192], "render group");
  const computeLayout = gpu.createPipelineLayout([computeBindings], "compute layout");
  const renderLayout = gpu.createPipelineLayout([renderBindings], "render layout");
  compute = gpu.createComputePipelineAsync(20, computeLayout, computeShader, "fill", "fill");
  render = gpu.createRenderPipelineAsync(21, renderLayout, renderShader, "vertex", renderShader, "fragment", format, "", gpu.TOPOLOGY_TRIANGLE_LIST, gpu.FRONT_FACE_CCW, gpu.CULL_NONE, 1, false, 0, 0, [], "triangle");
  if (timestamp) {
    queries = gpu.createQuerySet(1, 2, "compute timestamps");
    queryBuffer = gpu.createBuffer(256, gpu.BUFFER_USAGE_QUERY_RESOLVE | gpu.BUFFER_USAGE_COPY_SRC, false, "query resolve");
    queryReadback = gpu.createBuffer(16, gpu.BUFFER_USAGE_MAP_READ | gpu.BUFFER_USAGE_COPY_DST, false, "query readback");
    timings = reserveReadback(16);
  }
  flush();
}

export function event(type: number, requestId: number, handle: number, status: number, value: number, text: string): number {
  if (type === gpu.GPU_EVENT_CAPABILITIES) {
    if (status !== 0) { gpuReport("GPU_UNAVAILABLE " + text); return 0; }
    const capabilities = JSON.parse(text) as DemoCapabilities;
    setup(value !== 0, capabilities.format);
  } else if (type === gpu.GPU_EVENT_PIPELINE_READY && status === 0) {
    pipelinesReady++;
    if (pipelinesReady === 2) {
      ready = true;
      gpu.requestFrame();
      flush();
    }
  } else if (type === gpu.GPU_EVENT_MAP_READY && requestId === 30) {
    const view = new DataView(readbackView(result).buffer, readbackView(result).byteOffset, 4096);
    let bad = 0;
    for (let i = 0; i < 1024; i++) if (view.getUint32(i * 4, true) !== i * 3 + 7) bad++;
    gpuReport(bad === 0 ? "GPU_READBACK_OK 4096" : "GPU_READBACK_FAILED");
  } else if (type === gpu.GPU_EVENT_MAP_READY && requestId === 31) {
    const bytes = readbackView(timings);
    const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
    const begin = view.getUint32(0, true) + view.getUint32(4, true) * 4294967296;
    const end = view.getUint32(8, true) + view.getUint32(12, true) * 4294967296;
    gpuReport("GPU_TIMESTAMP_NS " + (end - begin));
  } else if (type === gpu.GPU_EVENT_WORK_DONE && requestId === 33) {
    gpuReport("GPU_COLOUR_CHANGED");
  } else if (type === gpu.GPU_EVENT_RESIZE && ready) {
    gpu.requestFrame();
    flush();
  } else if (status !== 0) {
    gpuReport("GPU_ERROR " + type + " " + requestId + " " + handle + " " + text);
  }
  return 0;
}

export function frame(_timeMs: number): number {
  if (!ready) return 0;
  const encoder = gpu.createCommandEncoder("demo frame");
  const pass = gpu.beginComputePass(encoder, queries, 0, 1, "fill storage");
  gpu.computeSetPipeline(pass, compute);
  gpu.computeSetBindGroup(pass, 0, computeGroup, []);
  gpu.computeDispatch(pass, 16, 1, 1);
  gpu.endComputePass(pass);
  const texture = gpu.getCurrentTexture();
  const view = gpu.createTextureView(texture, "", 0, 0, 0, 0, 0, 0, "frame view");
  const renderPass = gpu.beginRenderPass(encoder, view, 0, gpu.LOAD_CLEAR, gpu.STORE_STORE, colour, 0.12, 0.2, 1, 0, 0, 0, 1, 0, 0, 0, "triangle");
  gpu.renderSetPipeline(renderPass, render);
  gpu.renderSetBindGroup(renderPass, 0, renderGroup, []);
  gpu.renderDrawIndirect(renderPass, storage, 4096);
  gpu.endRenderPass(renderPass);
  if (firstFrame) {
    gpu.copyBufferToBuffer(encoder, storage, 0, readback, 0, 4096);
    if (queries !== 0) {
      gpu.resolveQuerySet(encoder, queries, 0, 2, queryBuffer, 0);
      gpu.copyBufferToBuffer(encoder, queryBuffer, 0, queryReadback, 0, 16);
    }
  }
  if (growOnNextFrame) {
    const upload = reserveUpload(67108864);
    gpu.writeBuffer(uploadBuffer, 0, { offset: upload.offset, length: 16777216 });
    growOnNextFrame = false;
  }
  const command = gpu.finishCommandEncoder(encoder, "demo commands");
  gpu.queueSubmit([command]);
  if (firstFrame) {
    gpu.mapAsync(30, readback, gpu.MAP_MODE_READ, 0, 4096, result);
    if (queries !== 0) gpu.mapAsync(31, queryReadback, gpu.MAP_MODE_READ, 0, 16, timings);
    gpu.onSubmittedWorkDone(32);
  }
  if (reportColour) { gpu.onSubmittedWorkDone(33); reportColour = false; }
  gpu.destroy(pass);
  gpu.destroy(renderPass);
  gpu.destroy(command);
  gpu.destroy(encoder);
  gpu.destroy(view);
  // Presentation textures belong to the canvas; release only their protocol handle.
  gpu.release(texture);
  flush();
  firstFrame = false;
  return 1;
}

export function message(kind: number, _payload: Uint8Array): number {
  if (kind === 1 && ready) {
    colour = colour < 0.3 ? 0.55 : 0.08;
    reportColour = true;
    gpu.requestFrame();
    flush();
  }
  return 0;
}

export function prepareUpload(): number {
  const upload = reserveUpload(33554432);
  const bytes = uploadView(upload);
  for (let i = 0; i < 16777216; i++) bytes[i] = i & 255;
  gpu.writeBuffer(uploadBuffer, 0, { offset: upload.offset, length: 16777216 });
  flush();
  return 0;
}

export function growFrame(): number {
  growOnNextFrame = true;
  gpu.requestFrame(); flush();
  return 0;
}
