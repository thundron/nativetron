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
export const GPU_TERMINAL_EVENTS = new Set([1,2,3,4,7,9]);
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
export const GPU_FIXED_LAYOUTS = {
  "requestDevice": {
    "code": 1,
    "bytes": 21,
    "fields": {
      "requestId": 1,
      "powerPreference": 5,
      "featureBits": 9,
      "maxBufferSize": 13
    }
  },
  "computeSetPipeline": {
    "code": 17,
    "bytes": 9,
    "fields": {
      "pass": 1,
      "pipeline": 5
    }
  },
  "computeDispatch": {
    "code": 19,
    "bytes": 17,
    "fields": {
      "pass": 1,
      "x": 5,
      "y": 9,
      "z": 13
    }
  },
  "computeDispatchIndirect": {
    "code": 20,
    "bytes": 17,
    "fields": {
      "pass": 1,
      "buffer": 5,
      "offset": 9
    }
  },
  "endComputePass": {
    "code": 21,
    "bytes": 5,
    "fields": {
      "pass": 1
    }
  },
  "renderSetViewport": {
    "code": 23,
    "bytes": 29,
    "fields": {
      "pass": 1,
      "x": 5,
      "y": 9,
      "width": 13,
      "height": 17,
      "minDepth": 21,
      "maxDepth": 25
    }
  },
  "renderSetScissor": {
    "code": 24,
    "bytes": 21,
    "fields": {
      "pass": 1,
      "x": 5,
      "y": 9,
      "width": 13,
      "height": 17
    }
  },
  "renderSetPipeline": {
    "code": 25,
    "bytes": 9,
    "fields": {
      "pass": 1,
      "pipeline": 5
    }
  },
  "renderSetVertexBuffer": {
    "code": 27,
    "bytes": 29,
    "fields": {
      "pass": 1,
      "slot": 5,
      "buffer": 9,
      "offset": 13,
      "size": 21
    }
  },
  "renderSetIndexBuffer": {
    "code": 28,
    "bytes": 29,
    "fields": {
      "pass": 1,
      "buffer": 5,
      "format": 9,
      "offset": 13,
      "size": 21
    }
  },
  "renderDraw": {
    "code": 29,
    "bytes": 21,
    "fields": {
      "pass": 1,
      "vertexCount": 5,
      "instanceCount": 9,
      "firstVertex": 13,
      "firstInstance": 17
    }
  },
  "renderDrawIndexed": {
    "code": 30,
    "bytes": 25,
    "fields": {
      "pass": 1,
      "indexCount": 5,
      "instanceCount": 9,
      "firstIndex": 13,
      "baseVertex": 17,
      "firstInstance": 21
    }
  },
  "renderDrawIndirect": {
    "code": 31,
    "bytes": 17,
    "fields": {
      "pass": 1,
      "buffer": 5,
      "offset": 9
    }
  },
  "renderDrawIndexedIndirect": {
    "code": 32,
    "bytes": 17,
    "fields": {
      "pass": 1,
      "buffer": 5,
      "offset": 9
    }
  },
  "endRenderPass": {
    "code": 33,
    "bytes": 5,
    "fields": {
      "pass": 1
    }
  },
  "copyBufferToBuffer": {
    "code": 34,
    "bytes": 37,
    "fields": {
      "encoder": 1,
      "source": 5,
      "sourceOffset": 9,
      "destination": 17,
      "destinationOffset": 21,
      "size": 29
    }
  },
  "copyBufferToTexture": {
    "code": 35,
    "bytes": 61,
    "fields": {
      "encoder": 1,
      "source": 5,
      "sourceOffset": 9,
      "bytesPerRow": 17,
      "rowsPerImage": 21,
      "destination": 25,
      "mipLevel": 29,
      "originX": 33,
      "originY": 37,
      "originZ": 41,
      "aspect": 45,
      "width": 49,
      "height": 53,
      "depth": 57
    }
  },
  "copyTextureToTexture": {
    "code": 36,
    "bytes": 57,
    "fields": {
      "encoder": 1,
      "source": 5,
      "sourceMip": 9,
      "sourceX": 13,
      "sourceY": 17,
      "sourceZ": 21,
      "destination": 25,
      "destinationMip": 29,
      "destinationX": 33,
      "destinationY": 37,
      "destinationZ": 41,
      "width": 45,
      "height": 49,
      "depth": 53
    }
  },
  "resolveQuerySet": {
    "code": 37,
    "bytes": 29,
    "fields": {
      "encoder": 1,
      "querySet": 5,
      "first": 9,
      "count": 13,
      "destination": 17,
      "offset": 21
    }
  },
  "writeBuffer": {
    "code": 40,
    "bytes": 21,
    "fields": {
      "buffer": 1,
      "bufferOffset": 5,
      "data": 13
    }
  },
  "writeTexture": {
    "code": 41,
    "bytes": 53,
    "fields": {
      "texture": 1,
      "mipLevel": 5,
      "originX": 9,
      "originY": 13,
      "originZ": 17,
      "aspect": 21,
      "data": 25,
      "bytesPerRow": 33,
      "rowsPerImage": 37,
      "width": 41,
      "height": 45,
      "depth": 49
    }
  },
  "getCurrentTexture": {
    "code": 43,
    "bytes": 5,
    "fields": {
      "handle": 1
    }
  },
  "destroy": {
    "code": 44,
    "bytes": 5,
    "fields": {
      "resource": 1
    }
  },
  "mapAsync": {
    "code": 45,
    "bytes": 37,
    "fields": {
      "requestId": 1,
      "buffer": 5,
      "mode": 9,
      "offset": 13,
      "size": 21,
      "destination": 29
    }
  },
  "onSubmittedWorkDone": {
    "code": 46,
    "bytes": 5,
    "fields": {
      "requestId": 1
    }
  },
  "requestFrame": {
    "code": 47,
    "bytes": 1,
    "fields": {}
  },
  "release": {
    "code": 48,
    "bytes": 5,
    "fields": {
      "resource": 1
    }
  },
  "unmap": {
    "code": 49,
    "bytes": 5,
    "fields": {
      "buffer": 1
    }
  },
  "writeMappedBuffer": {
    "code": 50,
    "bytes": 21,
    "fields": {
      "buffer": 1,
      "bufferOffset": 5,
      "data": 13
    }
  }
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
  let activeRequest = 0, activeHandle = 0;
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
      activeRequest = 0; activeHandle = 0;
      switch (u8()) {
        case 1: { const requestId = u32(); activeRequest = requestId; const powerPreference = u32(); const featureBits = u32(); const maxBufferSize = f64(); host.requestDevice(requestId, powerPreference, featureBits, maxBufferSize); break; }
        case 2: host.createBuffer(u32(), f64(), u32(), bool(), str()); break;
        case 3: host.createTexture(u32(), u32(), u32(), u32(), u32(), u32(), u32(), str(), u32(), str()); break;
        case 4: host.createTextureView(u32(), u32(), str(), u32(), u32(), u32(), u32(), u32(), u32(), str()); break;
        case 5: host.createSampler(u32(), u32(), u32(), u32(), u32(), u32(), u32(), f32(), f32(), u32(), u32(), str()); break;
        case 6: { const handle = u32(); activeHandle = handle; const requestId = u32(); activeRequest = requestId; const code = str(); const label = str(); host.createShaderModule(handle, requestId, code, label); break; }
        case 7: host.createBindGroupLayout(u32(), f64Array(), str()); break;
        case 8: host.createBindGroup(u32(), u32(), f64Array(), str()); break;
        case 9: host.createPipelineLayout(u32(), u32Array(), str()); break;
        case 10: host.createComputePipeline(u32(), u32(), u32(), str(), str()); break;
        case 11: { const handle = u32(); activeHandle = handle; const requestId = u32(); activeRequest = requestId; const layout = u32(); const shader = u32(); const entry = str(); const label = str(); host.createComputePipelineAsync(handle, requestId, layout, shader, entry, label); break; }
        case 12: host.createRenderPipeline(u32(), u32(), u32(), str(), u32(), str(), str(), str(), u32(), u32(), u32(), u32(), bool(), u32(), u32(), f64Array(), str()); break;
        case 13: { const handle = u32(); activeHandle = handle; const requestId = u32(); activeRequest = requestId; const layout = u32(); const vertexShader = u32(); const vertexEntry = str(); const fragmentShader = u32(); const fragmentEntry = str(); const colorFormat = str(); const depthFormat = str(); const topology = u32(); const frontFace = u32(); const cullMode = u32(); const sampleCount = u32(); const depthWrite = bool(); const depthCompare = u32(); const blend = u32(); const vertexLayouts = f64Array(); const label = str(); host.createRenderPipelineAsync(handle, requestId, layout, vertexShader, vertexEntry, fragmentShader, fragmentEntry, colorFormat, depthFormat, topology, frontFace, cullMode, sampleCount, depthWrite, depthCompare, blend, vertexLayouts, label); break; }
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
        case 45: { const requestId = u32(); activeRequest = requestId; const buffer = u32(); activeHandle = buffer; const mode = u32(); const offset = f64(); const size = f64(); const destination = range(true); host.mapAsync(requestId, buffer, mode, offset, size, destination); break; }
        case 46: { const requestId = u32(); activeRequest = requestId; host.onSubmittedWorkDone(requestId); break; }
        case 47: host.requestFrame(); break;
        case 48: host.release(u32()); break;
        case 49: host.unmap(u32()); break;
        case 50: host.writeMappedBuffer(u32(), f64(), range(false)); break;
        default: throw new Error("unknown GPU opcode");
      }
    }
    return true;
  } catch (error) {
    host.protocolError(error instanceof Error ? error.message : String(error), activeRequest, activeHandle);
    return false;
  }
}
