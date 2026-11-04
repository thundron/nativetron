// generated from gpu/ops.json by gpu/generate.mjs — do not edit
export const BUFFER_USAGE_MAP_READ = 1;
export const BUFFER_USAGE_MAP_WRITE = 2;
export const BUFFER_USAGE_COPY_SRC = 4;
export const BUFFER_USAGE_COPY_DST = 8;
export const BUFFER_USAGE_INDEX = 16;
export const BUFFER_USAGE_VERTEX = 32;
export const BUFFER_USAGE_UNIFORM = 64;
export const BUFFER_USAGE_STORAGE = 128;
export const BUFFER_USAGE_INDIRECT = 256;
export const BUFFER_USAGE_QUERY_RESOLVE = 512;
export const TEXTURE_USAGE_COPY_SRC = 1;
export const TEXTURE_USAGE_COPY_DST = 2;
export const TEXTURE_USAGE_TEXTURE_BINDING = 4;
export const TEXTURE_USAGE_STORAGE_BINDING = 8;
export const TEXTURE_USAGE_RENDER_ATTACHMENT = 16;
export const SHADER_STAGE_VERTEX = 1;
export const SHADER_STAGE_FRAGMENT = 2;
export const SHADER_STAGE_COMPUTE = 4;
export const FEATURE_TIMESTAMP_QUERY = 1;
export const MAP_MODE_READ = 1;
export const MAP_MODE_WRITE = 2;
export const LOAD_LOAD = 1;
export const LOAD_CLEAR = 2;
export const STORE_STORE = 1;
export const STORE_DISCARD = 2;
export const INDEX_UINT16 = 1;
export const INDEX_UINT32 = 2;
export const TOPOLOGY_POINT_LIST = 1;
export const TOPOLOGY_LINE_LIST = 2;
export const TOPOLOGY_LINE_STRIP = 3;
export const TOPOLOGY_TRIANGLE_LIST = 4;
export const TOPOLOGY_TRIANGLE_STRIP = 5;
export const FRONT_FACE_CCW = 1;
export const FRONT_FACE_CW = 2;
export const CULL_NONE = 0;
export const CULL_FRONT = 1;
export const CULL_BACK = 2;
export const STEP_VERTEX = 0;
export const STEP_INSTANCE = 1;
export const BINDING_BUFFER = 1;
export const BINDING_SAMPLER = 2;
export const BINDING_TEXTURE = 3;
export const BINDING_STORAGE_TEXTURE = 4;
export const BUFFER_BINDING_UNIFORM = 1;
export const BUFFER_BINDING_STORAGE = 2;
export const BUFFER_BINDING_READ_ONLY_STORAGE = 3;
export const SAMPLER_FILTERING = 1;
export const SAMPLER_NON_FILTERING = 2;
export const SAMPLER_COMPARISON = 3;
export const TEXTURE_SAMPLE_FLOAT = 1;
export const TEXTURE_SAMPLE_UNFILTERABLE_FLOAT = 2;
export const TEXTURE_SAMPLE_DEPTH = 3;
export const TEXTURE_SAMPLE_SINT = 4;
export const TEXTURE_SAMPLE_UINT = 5;
export const VIEW_1D = 1;
export const VIEW_2D = 2;
export const VIEW_2D_ARRAY = 3;
export const VIEW_CUBE = 4;
export const VIEW_CUBE_ARRAY = 5;
export const VIEW_3D = 6;
export const STORAGE_WRITE_ONLY = 1;
export const STORAGE_READ_ONLY = 2;
export const STORAGE_READ_WRITE = 3;
export const FORMAT_RGBA8UNORM = 1;
export const FORMAT_BGRA8UNORM = 2;
export const FORMAT_RGBA16FLOAT = 3;
export const FORMAT_R32FLOAT = 4;
export const FORMAT_R32UINT = 5;
export const FORMAT_RG32FLOAT = 6;
export const FORMAT_RGBA32FLOAT = 7;
export const FORMAT_DEPTH24PLUS = 8;
export const FORMAT_DEPTH32FLOAT = 9;
export const GPU_EVENT_CAPABILITIES = 1;
export const GPU_EVENT_PIPELINE_READY = 2;
export const GPU_EVENT_MAP_READY = 3;
export const GPU_EVENT_WORK_DONE = 4;
export const GPU_EVENT_DEVICE_LOST = 5;
export const GPU_EVENT_UNCAUGHT_ERROR = 6;
export const GPU_EVENT_SHADER_INFO = 7;
export const GPU_EVENT_RESIZE = 8;
export const GPU_EVENT_ERROR = 9;

export const GPU_PROTOCOL_VERSION = 1;
export const GPU_MAX_BATCH_BYTES = 16777216;
export const GPU_MAX_ARRAY_LENGTH = 65536;
export const GPU_HANDLE_SLOT_BITS = 20;
export const GPU_HANDLE_GENERATION_BITS = 12;
export const GPU_MAX_PENDING_REQUESTS = 1024;
export const GPU_ENUMS = {
  "dimension": [
    null,
    "1d",
    "2d",
    "3d"
  ],
  "view": [
    null,
    "1d",
    "2d",
    "2d-array",
    "cube",
    "cube-array",
    "3d"
  ],
  "address": [
    "clamp-to-edge",
    "repeat",
    "mirror-repeat"
  ],
  "filter": [
    "nearest",
    "linear"
  ],
  "compare": [
    null,
    "never",
    "less",
    "equal",
    "less-equal",
    "greater",
    "not-equal",
    "greater-equal",
    "always"
  ],
  "topology": [
    null,
    "point-list",
    "line-list",
    "line-strip",
    "triangle-list",
    "triangle-strip"
  ],
  "front": [
    null,
    "ccw",
    "cw"
  ],
  "cull": [
    "none",
    "front",
    "back"
  ],
  "load": [
    null,
    "load",
    "clear"
  ],
  "store": [
    null,
    "store",
    "discard"
  ],
  "aspect": [
    "all",
    "stencil-only",
    "depth-only"
  ],
  "buffer": [
    null,
    "uniform",
    "storage",
    "read-only-storage"
  ],
  "sampler": [
    null,
    "filtering",
    "non-filtering",
    "comparison"
  ],
  "sample": [
    null,
    "float",
    "unfilterable-float",
    "depth",
    "sint",
    "uint"
  ],
  "access": [
    null,
    "write-only",
    "read-only",
    "read-write"
  ],
  "format": [
    null,
    "rgba8unorm",
    "bgra8unorm",
    "rgba16float",
    "r32float",
    "r32uint",
    "rg32float",
    "rgba32float",
    "depth24plus",
    "depth32float"
  ],
  "vertexFormat": [
    null,
    "float32",
    "float32x2",
    "float32x3",
    "float32x4",
    "uint32",
    "uint32x2",
    "uint32x3",
    "uint32x4",
    "sint32",
    "sint32x2",
    "sint32x3",
    "sint32x4",
    "unorm8x4"
  ]
};
export const GPU_RECORDS = {
  "bindGroupLayout": [
    "binding",
    "visibility",
    "kind",
    "type",
    "dynamic",
    "minSize",
    "dimension",
    "multisampled",
    "format",
    "access"
  ],
  "bindGroup": [
    "binding",
    "kind",
    "resource",
    "offset",
    "size"
  ],
  "vertexBuffer": [
    "arrayStride",
    "step",
    "attributeCount"
  ],
  "vertexAttribute": [
    "shaderLocation",
    "offset",
    "format"
  ]
};

export function readGpuRecord(kind, values, offset = 0) {
  const fields = GPU_RECORDS[kind];
  if (!fields || offset + fields.length > values.length) throw new Error("truncated GPU descriptor record");
  const record = {};
  for (let i = 0; i < fields.length; i++) record[fields[i]] = values[offset + i];
  return { record, next: offset + fields.length };
}

const decoder = new TextDecoder();

export function decodeGpuBatch(host, bytes) {
  try {
    if (!(bytes instanceof Uint8Array)) throw new Error("GPU batch is not bytes");
    if (bytes.byteLength > GPU_MAX_BATCH_BYTES) throw new Error("GPU batch limit exceeded");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const need = (length) => { if (length < 0 || offset + length > bytes.byteLength) throw new Error("truncated GPU batch"); };
    const u8 = () => { need(1); return bytes[offset++]; };
    const bool = () => { const value = u8(); if (value > 1) throw new Error("invalid GPU boolean"); return value !== 0; };
    const u32 = () => { need(4); const value = view.getUint32(offset, true); offset += 4; return value; };
    const i32 = () => { need(4); const value = view.getInt32(offset, true); offset += 4; return value; };
    const f32 = () => { need(4); const value = view.getFloat32(offset, true); offset += 4; return value; };
    const f64 = () => { need(8); const value = view.getFloat64(offset, true); offset += 8; return value; };
    const str = () => { const length = u32(); need(length); const value = decoder.decode(bytes.subarray(offset, offset + length)); offset += length; return value; };
    const count = () => { const value = u32(); if (value > GPU_MAX_ARRAY_LENGTH) throw new Error("GPU array limit exceeded"); return value; };
    const u32Array = () => { const length = count(); const values = new Array(length); for (let i = 0; i < length; i++) values[i] = u32(); return values; };
    const f64Array = () => { const length = count(); const values = new Array(length); for (let i = 0; i < length; i++) values[i] = f64(); return values; };
    const range = (readback) => ({ offset: u32(), length: u32(), readback });
    while (offset < bytes.byteLength) {
      switch (u8()) {
        case 1: host.requestDevice(u32(), u32(), u32(), f64()); break;
        case 2: host.createBuffer(u32(), f64(), u32(), bool(), str()); break;
        case 3: host.createTexture(u32(), u32(), u32(), u32(), u32(), u32(), u32(), str(), u32(), str()); break;
        case 4: host.createTextureView(u32(), u32(), str(), u32(), u32(), u32(), u32(), u32(), u32(), str()); break;
        case 5: host.createSampler(u32(), u32(), u32(), u32(), u32(), u32(), u32(), f32(), f32(), u32(), u32(), str()); break;
        case 6: host.createShaderModule(u32(), u32(), str(), str()); break;
        case 7: host.createBindGroupLayout(u32(), f64Array(), str()); break;
        case 8: host.createBindGroup(u32(), u32(), f64Array(), str()); break;
        case 9: host.createPipelineLayout(u32(), u32Array(), str()); break;
        case 10: host.createComputePipeline(u32(), u32(), u32(), str(), str()); break;
        case 11: host.createComputePipelineAsync(u32(), u32(), u32(), u32(), str(), str()); break;
        case 12: host.createRenderPipeline(u32(), u32(), u32(), str(), u32(), str(), str(), str(), u32(), u32(), u32(), u32(), bool(), u32(), u32(), f64Array(), str()); break;
        case 13: host.createRenderPipelineAsync(u32(), u32(), u32(), u32(), str(), u32(), str(), str(), str(), u32(), u32(), u32(), u32(), bool(), u32(), u32(), f64Array(), str()); break;
        case 14: host.createQuerySet(u32(), u32(), u32(), str()); break;
        case 15: host.createCommandEncoder(u32(), str()); break;
        case 16: host.beginComputePass(u32(), u32(), u32(), u32(), u32(), str()); break;
        case 17: host.computeSetPipeline(u32(), u32()); break;
        case 18: host.computeSetBindGroup(u32(), u32(), u32(), u32Array()); break;
        case 19: host.computeDispatch(u32(), u32(), u32(), u32()); break;
        case 20: host.computeDispatchIndirect(u32(), u32(), f64()); break;
        case 21: host.endComputePass(u32()); break;
        case 22: host.beginRenderPass(u32(), u32(), u32(), u32(), u32(), u32(), f32(), f32(), f32(), f32(), u32(), u32(), u32(), f32(), u32(), u32(), u32(), str()); break;
        case 23: host.renderSetViewport(u32(), f32(), f32(), f32(), f32(), f32(), f32()); break;
        case 24: host.renderSetScissor(u32(), u32(), u32(), u32(), u32()); break;
        case 25: host.renderSetPipeline(u32(), u32()); break;
        case 26: host.renderSetBindGroup(u32(), u32(), u32(), u32Array()); break;
        case 27: host.renderSetVertexBuffer(u32(), u32(), u32(), f64(), f64()); break;
        case 28: host.renderSetIndexBuffer(u32(), u32(), u32(), f64(), f64()); break;
        case 29: host.renderDraw(u32(), u32(), u32(), u32(), u32()); break;
        case 30: host.renderDrawIndexed(u32(), u32(), u32(), u32(), i32(), u32()); break;
        case 31: host.renderDrawIndirect(u32(), u32(), f64()); break;
        case 32: host.renderDrawIndexedIndirect(u32(), u32(), f64()); break;
        case 33: host.endRenderPass(u32()); break;
        case 34: host.copyBufferToBuffer(u32(), u32(), f64(), u32(), f64(), f64()); break;
        case 35: host.copyBufferToTexture(u32(), u32(), f64(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32()); break;
        case 36: host.copyTextureToTexture(u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32(), u32()); break;
        case 37: host.resolveQuerySet(u32(), u32(), u32(), u32(), u32(), f64()); break;
        case 38: host.finishCommandEncoder(u32(), u32(), str()); break;
        case 39: host.queueSubmit(u32Array()); break;
        case 40: host.writeBuffer(u32(), f64(), range(false)); break;
        case 41: host.writeTexture(u32(), u32(), u32(), u32(), u32(), u32(), range(false), u32(), u32(), u32(), u32(), u32()); break;
        case 42: host.configureCanvas(str(), u32(), u32(), u32()); break;
        case 43: host.getCurrentTexture(u32()); break;
        case 44: host.destroy(u32()); break;
        case 45: host.mapAsync(u32(), u32(), u32(), f64(), f64(), range(true)); break;
        case 46: host.onSubmittedWorkDone(u32()); break;
        case 47: host.requestFrame(); break;
        case 48: host.release(u32()); break;
        case 49: host.unmap(u32()); break;
        case 50: host.writeMappedBuffer(u32(), f64(), range(false)); break;
        default: throw new Error("unknown GPU opcode");
      }
    }
    return true;
  } catch (error) {
    host.protocolError(error instanceof Error ? error.message : String(error));
    return false;
  }
}
