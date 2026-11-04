// generated from gpu/ops.json by gpu/generate.mjs — do not edit
import { begin, beginResult, end, u8, u32, i32, f32, f64, str, u32Array, f64Array, upload, readback, releaseHandle, type UploadSlice, type ReadbackSlice } from "./encode.js";

export const GPU_PROTOCOL_VERSION = 2;
export const GPU_PROTOCOL_IDENTITY = 0x49f0fe82;

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
export const MAP_MODE_READ = 1;
export const MAP_MODE_WRITE = 2;
export const BINDING_BUFFER = 1;
export const BINDING_SAMPLER = 2;
export const BINDING_TEXTURE = 3;
export const BINDING_STORAGE_TEXTURE = 4;
export const COLOR_WRITE_RED = 1;
export const COLOR_WRITE_GREEN = 2;
export const COLOR_WRITE_BLUE = 4;
export const COLOR_WRITE_ALPHA = 8;
export const COLOR_WRITE_ALL = 15;
export const FORMAT_RGBA8UNORM = 1;
export const FORMAT_BGRA8UNORM = 2;
export const FORMAT_RGBA16FLOAT = 3;
export const FORMAT_R32FLOAT = 4;
export const FORMAT_R32UINT = 5;
export const FORMAT_RG32FLOAT = 6;
export const FORMAT_RGBA32FLOAT = 7;
export const FORMAT_DEPTH24PLUS = 8;
export const FORMAT_DEPTH32FLOAT = 9;
export const FORMAT_R8UNORM = 10;
export const FORMAT_R8SNORM = 11;
export const FORMAT_R8UINT = 12;
export const FORMAT_R8SINT = 13;
export const FORMAT_R16UINT = 14;
export const FORMAT_R16SINT = 15;
export const FORMAT_R16FLOAT = 16;
export const FORMAT_RG8UNORM = 17;
export const FORMAT_RG8SNORM = 18;
export const FORMAT_RG8UINT = 19;
export const FORMAT_RG8SINT = 20;
export const FORMAT_R32SINT = 21;
export const FORMAT_RG16UINT = 22;
export const FORMAT_RG16SINT = 23;
export const FORMAT_RG16FLOAT = 24;
export const FORMAT_RGBA8UNORM_SRGB = 25;
export const FORMAT_RGBA8SNORM = 26;
export const FORMAT_RGBA8UINT = 27;
export const FORMAT_RGBA8SINT = 28;
export const FORMAT_BGRA8UNORM_SRGB = 29;
export const FORMAT_RGB10A2UINT = 30;
export const FORMAT_RGB10A2UNORM = 31;
export const FORMAT_RG11B10UFLOAT = 32;
export const FORMAT_RGB9E5UFLOAT = 33;
export const FORMAT_RG32UINT = 34;
export const FORMAT_RG32SINT = 35;
export const FORMAT_RGBA16UINT = 36;
export const FORMAT_RGBA16SINT = 37;
export const FORMAT_RGBA32UINT = 38;
export const FORMAT_RGBA32SINT = 39;
export const FORMAT_STENCIL8 = 40;
export const FORMAT_DEPTH16UNORM = 41;
export const FORMAT_DEPTH24PLUS_STENCIL8 = 42;
export const FORMAT_DEPTH32FLOAT_STENCIL8 = 43;
export const VERTEX_FORMAT_FLOAT32 = 1;
export const VERTEX_FORMAT_FLOAT32X2 = 2;
export const VERTEX_FORMAT_FLOAT32X3 = 3;
export const VERTEX_FORMAT_FLOAT32X4 = 4;
export const VERTEX_FORMAT_UINT32 = 5;
export const VERTEX_FORMAT_UINT32X2 = 6;
export const VERTEX_FORMAT_UINT32X3 = 7;
export const VERTEX_FORMAT_UINT32X4 = 8;
export const VERTEX_FORMAT_SINT32 = 9;
export const VERTEX_FORMAT_SINT32X2 = 10;
export const VERTEX_FORMAT_SINT32X3 = 11;
export const VERTEX_FORMAT_SINT32X4 = 12;
export const VERTEX_FORMAT_UNORM8X4 = 13;
export const VERTEX_FORMAT_UINT8 = 14;
export const VERTEX_FORMAT_UINT8X2 = 15;
export const VERTEX_FORMAT_UINT8X4 = 16;
export const VERTEX_FORMAT_SINT8 = 17;
export const VERTEX_FORMAT_SINT8X2 = 18;
export const VERTEX_FORMAT_SINT8X4 = 19;
export const VERTEX_FORMAT_UNORM8 = 20;
export const VERTEX_FORMAT_UNORM8X2 = 21;
export const VERTEX_FORMAT_SNORM8 = 22;
export const VERTEX_FORMAT_SNORM8X2 = 23;
export const VERTEX_FORMAT_SNORM8X4 = 24;
export const VERTEX_FORMAT_UINT16 = 25;
export const VERTEX_FORMAT_UINT16X2 = 26;
export const VERTEX_FORMAT_UINT16X4 = 27;
export const VERTEX_FORMAT_SINT16 = 28;
export const VERTEX_FORMAT_SINT16X2 = 29;
export const VERTEX_FORMAT_SINT16X4 = 30;
export const VERTEX_FORMAT_UNORM16 = 31;
export const VERTEX_FORMAT_UNORM16X2 = 32;
export const VERTEX_FORMAT_UNORM16X4 = 33;
export const VERTEX_FORMAT_SNORM16 = 34;
export const VERTEX_FORMAT_SNORM16X2 = 35;
export const VERTEX_FORMAT_SNORM16X4 = 36;
export const VERTEX_FORMAT_FLOAT16 = 37;
export const VERTEX_FORMAT_FLOAT16X2 = 38;
export const VERTEX_FORMAT_FLOAT16X4 = 39;
export const VERTEX_FORMAT_UNORM10_10_10_2 = 40;
export const VERTEX_FORMAT_UNORM8X4_BGRA = 41;
export const DIMENSION_1D = 1;
export const DIMENSION_2D = 2;
export const DIMENSION_3D = 3;
export const VIEW_1D = 1;
export const VIEW_2D = 2;
export const VIEW_2D_ARRAY = 3;
export const VIEW_CUBE = 4;
export const VIEW_CUBE_ARRAY = 5;
export const VIEW_3D = 6;
export const ADDRESS_CLAMP_TO_EDGE = 0;
export const ADDRESS_REPEAT = 1;
export const ADDRESS_MIRROR_REPEAT = 2;
export const FILTER_NEAREST = 0;
export const FILTER_LINEAR = 1;
export const COMPARE_NEVER = 1;
export const COMPARE_LESS = 2;
export const COMPARE_EQUAL = 3;
export const COMPARE_LESS_EQUAL = 4;
export const COMPARE_GREATER = 5;
export const COMPARE_NOT_EQUAL = 6;
export const COMPARE_GREATER_EQUAL = 7;
export const COMPARE_ALWAYS = 8;
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
export const LOAD_LOAD = 1;
export const LOAD_CLEAR = 2;
export const STORE_STORE = 1;
export const STORE_DISCARD = 2;
export const ASPECT_ALL = 0;
export const ASPECT_STENCIL_ONLY = 1;
export const ASPECT_DEPTH_ONLY = 2;
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
export const STORAGE_WRITE_ONLY = 1;
export const STORAGE_READ_ONLY = 2;
export const STORAGE_READ_WRITE = 3;
export const INDEX_UINT16 = 1;
export const INDEX_UINT32 = 2;
export const STEP_VERTEX = 0;
export const STEP_INSTANCE = 1;
export const BLEND_FACTOR_ZERO = 1;
export const BLEND_FACTOR_ONE = 2;
export const BLEND_FACTOR_SRC = 3;
export const BLEND_FACTOR_ONE_MINUS_SRC = 4;
export const BLEND_FACTOR_SRC_ALPHA = 5;
export const BLEND_FACTOR_ONE_MINUS_SRC_ALPHA = 6;
export const BLEND_FACTOR_DST = 7;
export const BLEND_FACTOR_ONE_MINUS_DST = 8;
export const BLEND_FACTOR_DST_ALPHA = 9;
export const BLEND_FACTOR_ONE_MINUS_DST_ALPHA = 10;
export const BLEND_FACTOR_SRC_ALPHA_SATURATED = 11;
export const BLEND_FACTOR_CONSTANT = 12;
export const BLEND_FACTOR_ONE_MINUS_CONSTANT = 13;
export const BLEND_FACTOR_SRC1 = 14;
export const BLEND_FACTOR_ONE_MINUS_SRC1 = 15;
export const BLEND_FACTOR_SRC1_ALPHA = 16;
export const BLEND_FACTOR_ONE_MINUS_SRC1_ALPHA = 17;
export const BLEND_OP_ADD = 1;
export const BLEND_OP_SUBTRACT = 2;
export const BLEND_OP_REVERSE_SUBTRACT = 3;
export const BLEND_OP_MIN = 4;
export const BLEND_OP_MAX = 5;
export const STENCIL_OP_KEEP = 1;
export const STENCIL_OP_ZERO = 2;
export const STENCIL_OP_REPLACE = 3;
export const STENCIL_OP_INVERT = 4;
export const STENCIL_OP_INCREMENT_CLAMP = 5;
export const STENCIL_OP_DECREMENT_CLAMP = 6;
export const STENCIL_OP_INCREMENT_WRAP = 7;
export const STENCIL_OP_DECREMENT_WRAP = 8;
export const QUERY_TYPE_TIMESTAMP = 1;
export const QUERY_TYPE_OCCLUSION = 2;
export const LIMIT_MODE_REQUIRED = 1;
export const LIMIT_MODE_PREFERRED = 2;
export const POWER_LOW_POWER = 0;
export const POWER_HIGH_PERFORMANCE = 1;
export const FEATURE_TIMESTAMP_QUERY = 1;
export const FEATURE_DEPTH_CLIP_CONTROL = 2;
export const FEATURE_DEPTH32FLOAT_STENCIL8 = 4;
export const FEATURE_TEXTURE_COMPRESSION_BC = 8;
export const FEATURE_TEXTURE_COMPRESSION_BC_SLICED_3D = 16;
export const FEATURE_TEXTURE_COMPRESSION_ETC2 = 32;
export const FEATURE_TEXTURE_COMPRESSION_ASTC = 64;
export const FEATURE_TEXTURE_COMPRESSION_ASTC_SLICED_3D = 128;
export const FEATURE_INDIRECT_FIRST_INSTANCE = 256;
export const FEATURE_SHADER_F16 = 512;
export const FEATURE_RG11B10UFLOAT_RENDERABLE = 1024;
export const FEATURE_BGRA8UNORM_STORAGE = 2048;
export const FEATURE_FLOAT32_FILTERABLE = 4096;
export const FEATURE_FLOAT32_BLENDABLE = 8192;
export const FEATURE_CLIP_DISTANCES = 16384;
export const FEATURE_DUAL_SOURCE_BLENDING = 32768;
export const FEATURE_SUBGROUPS = 65536;
export const FEATURE_CORE_FEATURES_AND_LIMITS = 131072;
export const FEATURE_PRIMITIVE_INDEX = 262144;
export const FEATURE_TEXTURE_FORMATS_TIER1 = 524288;
export const FEATURE_TEXTURE_FORMATS_TIER2 = 1048576;
export const LIMIT_MAX_TEXTURE_DIMENSION_1_D = 1;
export const LIMIT_MAX_TEXTURE_DIMENSION_2_D = 2;
export const LIMIT_MAX_TEXTURE_DIMENSION_3_D = 3;
export const LIMIT_MAX_TEXTURE_ARRAY_LAYERS = 4;
export const LIMIT_MAX_BIND_GROUPS = 5;
export const LIMIT_MAX_BIND_GROUPS_PLUS_VERTEX_BUFFERS = 6;
export const LIMIT_MAX_BINDINGS_PER_BIND_GROUP = 7;
export const LIMIT_MAX_DYNAMIC_UNIFORM_BUFFERS_PER_PIPELINE_LAYOUT = 8;
export const LIMIT_MAX_DYNAMIC_STORAGE_BUFFERS_PER_PIPELINE_LAYOUT = 9;
export const LIMIT_MAX_SAMPLED_TEXTURES_PER_SHADER_STAGE = 10;
export const LIMIT_MAX_SAMPLERS_PER_SHADER_STAGE = 11;
export const LIMIT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE = 12;
export const LIMIT_MAX_STORAGE_TEXTURES_PER_SHADER_STAGE = 13;
export const LIMIT_MAX_UNIFORM_BUFFERS_PER_SHADER_STAGE = 14;
export const LIMIT_MAX_UNIFORM_BUFFER_BINDING_SIZE = 15;
export const LIMIT_MAX_STORAGE_BUFFER_BINDING_SIZE = 16;
export const LIMIT_MIN_UNIFORM_BUFFER_OFFSET_ALIGNMENT = 17;
export const LIMIT_MIN_STORAGE_BUFFER_OFFSET_ALIGNMENT = 18;
export const LIMIT_MAX_VERTEX_BUFFERS = 19;
export const LIMIT_MAX_BUFFER_SIZE = 20;
export const LIMIT_MAX_VERTEX_ATTRIBUTES = 21;
export const LIMIT_MAX_VERTEX_BUFFER_ARRAY_STRIDE = 22;
export const LIMIT_MAX_INTER_STAGE_SHADER_VARIABLES = 23;
export const LIMIT_MAX_COLOR_ATTACHMENTS = 24;
export const LIMIT_MAX_COLOR_ATTACHMENT_BYTES_PER_SAMPLE = 25;
export const LIMIT_MAX_COMPUTE_WORKGROUP_STORAGE_SIZE = 26;
export const LIMIT_MAX_COMPUTE_INVOCATIONS_PER_WORKGROUP = 27;
export const LIMIT_MAX_COMPUTE_WORKGROUP_SIZE_X = 28;
export const LIMIT_MAX_COMPUTE_WORKGROUP_SIZE_Y = 29;
export const LIMIT_MAX_COMPUTE_WORKGROUP_SIZE_Z = 30;
export const LIMIT_MAX_COMPUTE_WORKGROUPS_PER_DIMENSION = 31;
export const RECORD_BIND_GROUP_LAYOUT_WIDTH = 10;
export const RECORD_BIND_GROUP_WIDTH = 5;
export const RECORD_VERTEX_BUFFER_WIDTH = 3;
export const RECORD_VERTEX_ATTRIBUTE_WIDTH = 3;
export const RECORD_COLOR_TARGET_WIDTH = 9;
export const RECORD_PRIMITIVE_WIDTH = 5;
export const RECORD_DEPTH_STENCIL_WIDTH = 16;
export const RECORD_MULTISAMPLE_WIDTH = 3;
export const RECORD_COLOR_ATTACHMENT_WIDTH = 9;
export const RECORD_DEPTH_STENCIL_ATTACHMENT_WIDTH = 9;
export const RECORD_LIMIT_REQUEST_WIDTH = 3;
export const RECORD_CONSTANT_WIDTH = 3;

export const GPU_EVENT_CAPABILITIES = 1;
export const GPU_EVENT_PIPELINE_READY = 2;
export const GPU_EVENT_MAP_READY = 3;
export const GPU_EVENT_WORK_DONE = 4;
export const GPU_EVENT_DEVICE_LOST = 5;
export const GPU_EVENT_UNCAUGHT_ERROR = 6;
export const GPU_EVENT_SHADER_INFO = 7;
export const GPU_EVENT_RESIZE = 8;
export const GPU_EVENT_ERROR = 9;

export const GPU_STATUS_OK = 0;
export const GPU_STATUS_ERROR = 1;
export const GPU_STATUS_CANCELLED = 2;
export const GPU_STATUS_LOST = 3;

export function requestDevice(requestId: number, powerPreference: number, featureBits: number, maxBufferSize: number): void {
  begin(1);
  u32(requestId);
  u32(powerPreference);
  u32(featureBits);
  f64(maxBufferSize);
  end();
}

export function createBuffer(size: number, usage: number, mappedAtCreation: boolean, label: string): number {
  const handle = beginResult(2);
  f64(size);
  u32(usage);
  u8(mappedAtCreation ? 1 : 0);
  str(label);
  end();
  return handle;
}

export function createTexture(width: number, height: number, depth: number, mipLevels: number, samples: number, dimension: number, format: string, usage: number, label: string): number {
  const handle = beginResult(3);
  u32(width);
  u32(height);
  u32(depth);
  u32(mipLevels);
  u32(samples);
  u32(dimension);
  str(format);
  u32(usage);
  str(label);
  end();
  return handle;
}

export function createTextureView(texture: number, format: string, dimension: number, baseMip: number, mipCount: number, baseLayer: number, layerCount: number, aspect: number, label: string): number {
  const handle = beginResult(4);
  u32(texture);
  str(format);
  u32(dimension);
  u32(baseMip);
  u32(mipCount);
  u32(baseLayer);
  u32(layerCount);
  u32(aspect);
  str(label);
  end();
  return handle;
}

export function createSampler(addressU: number, addressV: number, addressW: number, magFilter: number, minFilter: number, mipmapFilter: number, lodMin: number, lodMax: number, compare: number, maxAnisotropy: number, label: string): number {
  const handle = beginResult(5);
  u32(addressU);
  u32(addressV);
  u32(addressW);
  u32(magFilter);
  u32(minFilter);
  u32(mipmapFilter);
  f32(lodMin);
  f32(lodMax);
  u32(compare);
  u32(maxAnisotropy);
  str(label);
  end();
  return handle;
}

export function createShaderModule(requestId: number, code: string, label: string): number {
  const handle = beginResult(6);
  u32(requestId);
  str(code);
  str(label);
  end();
  return handle;
}

export function createBindGroupLayout(entries: number[], label: string): number {
  const handle = beginResult(7);
  f64Array(entries);
  str(label);
  end();
  return handle;
}

export function createBindGroup(layout: number, entries: number[], label: string): number {
  const handle = beginResult(8);
  u32(layout);
  f64Array(entries);
  str(label);
  end();
  return handle;
}

export function createPipelineLayout(layouts: number[], label: string): number {
  const handle = beginResult(9);
  u32Array(layouts);
  str(label);
  end();
  return handle;
}

export function createComputePipeline(layout: number, shader: number, entry: string, label: string): number {
  const handle = beginResult(10);
  u32(layout);
  u32(shader);
  str(entry);
  str(label);
  end();
  return handle;
}

export function createComputePipelineAsync(requestId: number, layout: number, shader: number, entry: string, label: string): number {
  const handle = beginResult(11);
  u32(requestId);
  u32(layout);
  u32(shader);
  str(entry);
  str(label);
  end();
  return handle;
}

export function createRenderPipeline(layout: number, vertexShader: number, vertexEntry: string, fragmentShader: number, fragmentEntry: string, colorFormat: string, depthFormat: string, topology: number, frontFace: number, cullMode: number, sampleCount: number, depthWrite: boolean, depthCompare: number, blend: number, vertexLayouts: number[], label: string): number {
  const handle = beginResult(12);
  u32(layout);
  u32(vertexShader);
  str(vertexEntry);
  u32(fragmentShader);
  str(fragmentEntry);
  str(colorFormat);
  str(depthFormat);
  u32(topology);
  u32(frontFace);
  u32(cullMode);
  u32(sampleCount);
  u8(depthWrite ? 1 : 0);
  u32(depthCompare);
  u32(blend);
  f64Array(vertexLayouts);
  str(label);
  end();
  return handle;
}

export function createRenderPipelineAsync(requestId: number, layout: number, vertexShader: number, vertexEntry: string, fragmentShader: number, fragmentEntry: string, colorFormat: string, depthFormat: string, topology: number, frontFace: number, cullMode: number, sampleCount: number, depthWrite: boolean, depthCompare: number, blend: number, vertexLayouts: number[], label: string): number {
  const handle = beginResult(13);
  u32(requestId);
  u32(layout);
  u32(vertexShader);
  str(vertexEntry);
  u32(fragmentShader);
  str(fragmentEntry);
  str(colorFormat);
  str(depthFormat);
  u32(topology);
  u32(frontFace);
  u32(cullMode);
  u32(sampleCount);
  u8(depthWrite ? 1 : 0);
  u32(depthCompare);
  u32(blend);
  f64Array(vertexLayouts);
  str(label);
  end();
  return handle;
}

export function createQuerySet(type: number, count: number, label: string): number {
  const handle = beginResult(14);
  u32(type);
  u32(count);
  str(label);
  end();
  return handle;
}

export function createCommandEncoder(label: string): number {
  const handle = beginResult(15);
  str(label);
  end();
  return handle;
}

export function beginComputePass(encoder: number, querySet: number, beginIndex: number, endIndex: number, label: string): number {
  const handle = beginResult(16);
  u32(encoder);
  u32(querySet);
  u32(beginIndex);
  u32(endIndex);
  str(label);
  end();
  return handle;
}

export function computeSetPipeline(pass: number, pipeline: number): void {
  begin(17);
  u32(pass);
  u32(pipeline);
  end();
}

export function computeSetBindGroup(pass: number, index: number, bindGroup: number, dynamicOffsets: number[]): void {
  begin(18);
  u32(pass);
  u32(index);
  u32(bindGroup);
  u32Array(dynamicOffsets);
  end();
}

export function computeDispatch(pass: number, x: number, y: number, z: number): void {
  begin(19);
  u32(pass);
  u32(x);
  u32(y);
  u32(z);
  end();
}

export function computeDispatchIndirect(pass: number, buffer: number, offset: number): void {
  begin(20);
  u32(pass);
  u32(buffer);
  f64(offset);
  end();
}

export function endComputePass(pass: number): void {
  begin(21);
  u32(pass);
  end();
}

export function beginRenderPass(encoder: number, colorView: number, resolveView: number, colorLoad: number, colorStore: number, clearR: number, clearG: number, clearB: number, clearA: number, depthView: number, depthLoad: number, depthStore: number, clearDepth: number, querySet: number, beginIndex: number, endIndex: number, label: string): number {
  const handle = beginResult(22);
  u32(encoder);
  u32(colorView);
  u32(resolveView);
  u32(colorLoad);
  u32(colorStore);
  f32(clearR);
  f32(clearG);
  f32(clearB);
  f32(clearA);
  u32(depthView);
  u32(depthLoad);
  u32(depthStore);
  f32(clearDepth);
  u32(querySet);
  u32(beginIndex);
  u32(endIndex);
  str(label);
  end();
  return handle;
}

export function renderSetViewport(pass: number, x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
  begin(23);
  u32(pass);
  f32(x);
  f32(y);
  f32(width);
  f32(height);
  f32(minDepth);
  f32(maxDepth);
  end();
}

export function renderSetScissor(pass: number, x: number, y: number, width: number, height: number): void {
  begin(24);
  u32(pass);
  u32(x);
  u32(y);
  u32(width);
  u32(height);
  end();
}

export function renderSetPipeline(pass: number, pipeline: number): void {
  begin(25);
  u32(pass);
  u32(pipeline);
  end();
}

export function renderSetBindGroup(pass: number, index: number, bindGroup: number, dynamicOffsets: number[]): void {
  begin(26);
  u32(pass);
  u32(index);
  u32(bindGroup);
  u32Array(dynamicOffsets);
  end();
}

export function renderSetVertexBuffer(pass: number, slot: number, buffer: number, offset: number, size: number): void {
  begin(27);
  u32(pass);
  u32(slot);
  u32(buffer);
  f64(offset);
  f64(size);
  end();
}

export function renderSetIndexBuffer(pass: number, buffer: number, format: number, offset: number, size: number): void {
  begin(28);
  u32(pass);
  u32(buffer);
  u32(format);
  f64(offset);
  f64(size);
  end();
}

export function renderDraw(pass: number, vertexCount: number, instanceCount: number, firstVertex: number, firstInstance: number): void {
  begin(29);
  u32(pass);
  u32(vertexCount);
  u32(instanceCount);
  u32(firstVertex);
  u32(firstInstance);
  end();
}

export function renderDrawIndexed(pass: number, indexCount: number, instanceCount: number, firstIndex: number, baseVertex: number, firstInstance: number): void {
  begin(30);
  u32(pass);
  u32(indexCount);
  u32(instanceCount);
  u32(firstIndex);
  i32(baseVertex);
  u32(firstInstance);
  end();
}

export function renderDrawIndirect(pass: number, buffer: number, offset: number): void {
  begin(31);
  u32(pass);
  u32(buffer);
  f64(offset);
  end();
}

export function renderDrawIndexedIndirect(pass: number, buffer: number, offset: number): void {
  begin(32);
  u32(pass);
  u32(buffer);
  f64(offset);
  end();
}

export function endRenderPass(pass: number): void {
  begin(33);
  u32(pass);
  end();
}

export function copyBufferToBuffer(encoder: number, source: number, sourceOffset: number, destination: number, destinationOffset: number, size: number): void {
  begin(34);
  u32(encoder);
  u32(source);
  f64(sourceOffset);
  u32(destination);
  f64(destinationOffset);
  f64(size);
  end();
}

export function copyBufferToTexture(encoder: number, source: number, sourceOffset: number, bytesPerRow: number, rowsPerImage: number, destination: number, mipLevel: number, originX: number, originY: number, originZ: number, aspect: number, width: number, height: number, depth: number): void {
  begin(35);
  u32(encoder);
  u32(source);
  f64(sourceOffset);
  u32(bytesPerRow);
  u32(rowsPerImage);
  u32(destination);
  u32(mipLevel);
  u32(originX);
  u32(originY);
  u32(originZ);
  u32(aspect);
  u32(width);
  u32(height);
  u32(depth);
  end();
}

export function copyTextureToTexture(encoder: number, source: number, sourceMip: number, sourceX: number, sourceY: number, sourceZ: number, destination: number, destinationMip: number, destinationX: number, destinationY: number, destinationZ: number, width: number, height: number, depth: number): void {
  begin(36);
  u32(encoder);
  u32(source);
  u32(sourceMip);
  u32(sourceX);
  u32(sourceY);
  u32(sourceZ);
  u32(destination);
  u32(destinationMip);
  u32(destinationX);
  u32(destinationY);
  u32(destinationZ);
  u32(width);
  u32(height);
  u32(depth);
  end();
}

export function resolveQuerySet(encoder: number, querySet: number, first: number, count: number, destination: number, offset: number): void {
  begin(37);
  u32(encoder);
  u32(querySet);
  u32(first);
  u32(count);
  u32(destination);
  f64(offset);
  end();
}

export function finishCommandEncoder(encoder: number, label: string): number {
  const handle = beginResult(38);
  u32(encoder);
  str(label);
  end();
  return handle;
}

export function queueSubmit(commandBuffers: number[]): void {
  begin(39);
  u32Array(commandBuffers);
  end();
}

export function writeBuffer(buffer: number, bufferOffset: number, data: UploadSlice): void {
  begin(40);
  u32(buffer);
  f64(bufferOffset);
  upload(data);
  end();
}

export function writeTexture(texture: number, mipLevel: number, originX: number, originY: number, originZ: number, aspect: number, data: UploadSlice, bytesPerRow: number, rowsPerImage: number, width: number, height: number, depth: number): void {
  begin(41);
  u32(texture);
  u32(mipLevel);
  u32(originX);
  u32(originY);
  u32(originZ);
  u32(aspect);
  upload(data);
  u32(bytesPerRow);
  u32(rowsPerImage);
  u32(width);
  u32(height);
  u32(depth);
  end();
}

export function configureCanvas(format: string, usage: number, alphaMode: number, colorSpace: number): void {
  begin(42);
  str(format);
  u32(usage);
  u32(alphaMode);
  u32(colorSpace);
  end();
}

export function getCurrentTexture(): number {
  const handle = beginResult(43);
  end();
  return handle;
}

export function destroy(resource: number): void {
  begin(44);
  u32(resource);
  end();
  releaseHandle(resource);
}

export function mapAsync(requestId: number, buffer: number, mode: number, offset: number, size: number, destination: ReadbackSlice): void {
  begin(45);
  u32(requestId);
  u32(buffer);
  u32(mode);
  f64(offset);
  f64(size);
  readback(destination);
  end();
}

export function onSubmittedWorkDone(requestId: number): void {
  begin(46);
  u32(requestId);
  end();
}

export function requestFrame(): void {
  begin(47);
  end();
}

export function release(resource: number): void {
  begin(48);
  u32(resource);
  end();
  releaseHandle(resource);
}

export function unmap(buffer: number): void {
  begin(49);
  u32(buffer);
  end();
}

export function writeMappedBuffer(buffer: number, bufferOffset: number, data: UploadSlice): void {
  begin(50);
  u32(buffer);
  f64(bufferOffset);
  upload(data);
  end();
}

export function requestDeviceWith(requestId: number, powerPreference: number, requiredFeatures: number, optionalFeatures: number, limits: number[]): void {
  begin(52);
  u32(requestId);
  u32(powerPreference);
  u32(requiredFeatures);
  u32(optionalFeatures);
  f64Array(limits);
  end();
}

export function cancelRequest(request: number): void {
  begin(53);
  u32(request);
  end();
}

export function destroyDevice(): void {
  begin(54);
  end();
}

export function createRenderPipelineWith(layout: number, vertexShader: number, vertexEntry: string, fragmentShader: number, fragmentEntry: string, targets: number[], primitive: number[], depthStencil: number[], multisample: number[], vertexLayouts: number[], constants: number[], label: string): number {
  const handle = beginResult(55);
  u32(layout);
  u32(vertexShader);
  str(vertexEntry);
  u32(fragmentShader);
  str(fragmentEntry);
  f64Array(targets);
  f64Array(primitive);
  f64Array(depthStencil);
  f64Array(multisample);
  f64Array(vertexLayouts);
  f64Array(constants);
  str(label);
  end();
  return handle;
}

export function createRenderPipelineAsyncWith(requestId: number, layout: number, vertexShader: number, vertexEntry: string, fragmentShader: number, fragmentEntry: string, targets: number[], primitive: number[], depthStencil: number[], multisample: number[], vertexLayouts: number[], constants: number[], label: string): number {
  const handle = beginResult(56);
  u32(requestId);
  u32(layout);
  u32(vertexShader);
  str(vertexEntry);
  u32(fragmentShader);
  str(fragmentEntry);
  f64Array(targets);
  f64Array(primitive);
  f64Array(depthStencil);
  f64Array(multisample);
  f64Array(vertexLayouts);
  f64Array(constants);
  str(label);
  end();
  return handle;
}

export function createComputePipelineWith(layout: number, shader: number, entry: string, constants: number[], label: string): number {
  const handle = beginResult(57);
  u32(layout);
  u32(shader);
  str(entry);
  f64Array(constants);
  str(label);
  end();
  return handle;
}

export function createComputePipelineAsyncWith(requestId: number, layout: number, shader: number, entry: string, constants: number[], label: string): number {
  const handle = beginResult(58);
  u32(requestId);
  u32(layout);
  u32(shader);
  str(entry);
  f64Array(constants);
  str(label);
  end();
  return handle;
}

export function beginRenderPassWith(encoder: number, colors: number[], depthStencil: number[], occlusionQuerySet: number, timestampQuerySet: number, beginIndex: number, endIndex: number, label: string): number {
  const handle = beginResult(59);
  u32(encoder);
  f64Array(colors);
  f64Array(depthStencil);
  u32(occlusionQuerySet);
  u32(timestampQuerySet);
  u32(beginIndex);
  u32(endIndex);
  str(label);
  end();
  return handle;
}

export function renderSetStencilReference(pass: number, reference: number): void {
  begin(60);
  u32(pass);
  u32(reference);
  end();
}

export function renderSetBlendConstant(pass: number, r: number, g: number, b: number, a: number): void {
  begin(61);
  u32(pass);
  f64(r);
  f64(g);
  f64(b);
  f64(a);
  end();
}

export function renderBeginOcclusionQuery(pass: number, index: number): void {
  begin(62);
  u32(pass);
  u32(index);
  end();
}

export function renderEndOcclusionQuery(pass: number): void {
  begin(63);
  u32(pass);
  end();
}

export function copyTextureToBuffer(encoder: number, source: number, mipLevel: number, originX: number, originY: number, originZ: number, aspect: number, destination: number, offset: number, bytesPerRow: number, rowsPerImage: number, width: number, height: number, depth: number): void {
  begin(64);
  u32(encoder);
  u32(source);
  u32(mipLevel);
  u32(originX);
  u32(originY);
  u32(originZ);
  u32(aspect);
  u32(destination);
  f64(offset);
  u32(bytesPerRow);
  u32(rowsPerImage);
  u32(width);
  u32(height);
  u32(depth);
  end();
}

export function clearBuffer(encoder: number, buffer: number, offset: number, size: number): void {
  begin(65);
  u32(encoder);
  u32(buffer);
  f64(offset);
  f64(size);
  end();
}

export function recordBindGroupLayout(out: number[], binding: number, visibility: number, kind: number, type: number, dynamic: number, minSize: number, dimension: number, multisampled: number, format: number, access: number): number[] {
  out.push(binding);
  out.push(visibility);
  out.push(kind);
  out.push(type);
  out.push(dynamic);
  out.push(minSize);
  out.push(dimension);
  out.push(multisampled);
  out.push(format);
  out.push(access);
  return out;
}

export function recordBindGroup(out: number[], binding: number, kind: number, resource: number, offset: number, size: number): number[] {
  out.push(binding);
  out.push(kind);
  out.push(resource);
  out.push(offset);
  out.push(size);
  return out;
}

export function recordVertexBuffer(out: number[], arrayStride: number, step: number, attributeCount: number): number[] {
  out.push(arrayStride);
  out.push(step);
  out.push(attributeCount);
  return out;
}

export function recordVertexAttribute(out: number[], shaderLocation: number, offset: number, format: number): number[] {
  out.push(shaderLocation);
  out.push(offset);
  out.push(format);
  return out;
}

export function recordColorTarget(out: number[], format: number, writeMask: number, blend: number, colorOperation: number, colorSrcFactor: number, colorDstFactor: number, alphaOperation: number, alphaSrcFactor: number, alphaDstFactor: number): number[] {
  out.push(format);
  out.push(writeMask);
  out.push(blend);
  out.push(colorOperation);
  out.push(colorSrcFactor);
  out.push(colorDstFactor);
  out.push(alphaOperation);
  out.push(alphaSrcFactor);
  out.push(alphaDstFactor);
  return out;
}

export function recordPrimitive(out: number[], topology: number, stripIndexFormat: number, frontFace: number, cullMode: number, unclippedDepth: number): number[] {
  out.push(topology);
  out.push(stripIndexFormat);
  out.push(frontFace);
  out.push(cullMode);
  out.push(unclippedDepth);
  return out;
}

export function recordDepthStencil(out: number[], format: number, depthWrite: number, depthCompare: number, frontCompare: number, frontFail: number, frontDepthFail: number, frontPass: number, backCompare: number, backFail: number, backDepthFail: number, backPass: number, stencilReadMask: number, stencilWriteMask: number, depthBias: number, depthBiasSlopeScale: number, depthBiasClamp: number): number[] {
  out.push(format);
  out.push(depthWrite);
  out.push(depthCompare);
  out.push(frontCompare);
  out.push(frontFail);
  out.push(frontDepthFail);
  out.push(frontPass);
  out.push(backCompare);
  out.push(backFail);
  out.push(backDepthFail);
  out.push(backPass);
  out.push(stencilReadMask);
  out.push(stencilWriteMask);
  out.push(depthBias);
  out.push(depthBiasSlopeScale);
  out.push(depthBiasClamp);
  return out;
}

export function recordMultisample(out: number[], count: number, mask: number, alphaToCoverage: number): number[] {
  out.push(count);
  out.push(mask);
  out.push(alphaToCoverage);
  return out;
}

export function recordColorAttachment(out: number[], view: number, resolveView: number, load: number, store: number, clearR: number, clearG: number, clearB: number, clearA: number, depthSlicePlusOne: number): number[] {
  out.push(view);
  out.push(resolveView);
  out.push(load);
  out.push(store);
  out.push(clearR);
  out.push(clearG);
  out.push(clearB);
  out.push(clearA);
  out.push(depthSlicePlusOne);
  return out;
}

export function recordDepthStencilAttachment(out: number[], view: number, depthLoad: number, depthStore: number, depthClear: number, depthReadOnly: number, stencilLoad: number, stencilStore: number, stencilClear: number, stencilReadOnly: number): number[] {
  out.push(view);
  out.push(depthLoad);
  out.push(depthStore);
  out.push(depthClear);
  out.push(depthReadOnly);
  out.push(stencilLoad);
  out.push(stencilStore);
  out.push(stencilClear);
  out.push(stencilReadOnly);
  return out;
}

export function recordLimitRequest(out: number[], limit: number, value: number, mode: number): number[] {
  out.push(limit);
  out.push(value);
  out.push(mode);
  return out;
}

export function recordConstant(out: number[], stages: number, id: number, value: number): number[] {
  out.push(stages);
  out.push(id);
  out.push(value);
  return out;
}
