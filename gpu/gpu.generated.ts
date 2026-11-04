// generated from gpu/ops.json by gpu/generate.mjs — do not edit
import { u8, u32, i32, f32, f64, str, u32Array, f64Array, upload, readback, allocateHandle, releaseHandle, type UploadSlice, type ReadbackSlice } from "./encode.js";

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

export function requestDevice(requestId: number, powerPreference: number, featureBits: number, maxBufferSize: number): void {
  u8(1);
  u32(requestId);
  u32(powerPreference);
  u32(featureBits);
  f64(maxBufferSize);
}

export function createBuffer(size: number, usage: number, mappedAtCreation: boolean, label: string): number {
  const handle = allocateHandle();
  u8(2);
  u32(handle);
  f64(size);
  u32(usage);
  u8(mappedAtCreation ? 1 : 0);
  str(label);
  return handle;
}

export function createTexture(width: number, height: number, depth: number, mipLevels: number, samples: number, dimension: number, format: string, usage: number, label: string): number {
  const handle = allocateHandle();
  u8(3);
  u32(handle);
  u32(width);
  u32(height);
  u32(depth);
  u32(mipLevels);
  u32(samples);
  u32(dimension);
  str(format);
  u32(usage);
  str(label);
  return handle;
}

export function createTextureView(texture: number, format: string, dimension: number, baseMip: number, mipCount: number, baseLayer: number, layerCount: number, aspect: number, label: string): number {
  const handle = allocateHandle();
  u8(4);
  u32(handle);
  u32(texture);
  str(format);
  u32(dimension);
  u32(baseMip);
  u32(mipCount);
  u32(baseLayer);
  u32(layerCount);
  u32(aspect);
  str(label);
  return handle;
}

export function createSampler(addressU: number, addressV: number, addressW: number, magFilter: number, minFilter: number, mipmapFilter: number, lodMin: number, lodMax: number, compare: number, maxAnisotropy: number, label: string): number {
  const handle = allocateHandle();
  u8(5);
  u32(handle);
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
  return handle;
}

export function createShaderModule(requestId: number, code: string, label: string): number {
  const handle = allocateHandle();
  u8(6);
  u32(handle);
  u32(requestId);
  str(code);
  str(label);
  return handle;
}

export function createBindGroupLayout(entries: number[], label: string): number {
  const handle = allocateHandle();
  u8(7);
  u32(handle);
  f64Array(entries);
  str(label);
  return handle;
}

export function createBindGroup(layout: number, entries: number[], label: string): number {
  const handle = allocateHandle();
  u8(8);
  u32(handle);
  u32(layout);
  f64Array(entries);
  str(label);
  return handle;
}

export function createPipelineLayout(layouts: number[], label: string): number {
  const handle = allocateHandle();
  u8(9);
  u32(handle);
  u32Array(layouts);
  str(label);
  return handle;
}

export function createComputePipeline(layout: number, shader: number, entry: string, label: string): number {
  const handle = allocateHandle();
  u8(10);
  u32(handle);
  u32(layout);
  u32(shader);
  str(entry);
  str(label);
  return handle;
}

export function createComputePipelineAsync(requestId: number, layout: number, shader: number, entry: string, label: string): number {
  const handle = allocateHandle();
  u8(11);
  u32(handle);
  u32(requestId);
  u32(layout);
  u32(shader);
  str(entry);
  str(label);
  return handle;
}

export function createRenderPipeline(layout: number, vertexShader: number, vertexEntry: string, fragmentShader: number, fragmentEntry: string, colorFormat: string, depthFormat: string, topology: number, frontFace: number, cullMode: number, sampleCount: number, depthWrite: boolean, depthCompare: number, blend: number, vertexLayouts: number[], label: string): number {
  const handle = allocateHandle();
  u8(12);
  u32(handle);
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
  return handle;
}

export function createRenderPipelineAsync(requestId: number, layout: number, vertexShader: number, vertexEntry: string, fragmentShader: number, fragmentEntry: string, colorFormat: string, depthFormat: string, topology: number, frontFace: number, cullMode: number, sampleCount: number, depthWrite: boolean, depthCompare: number, blend: number, vertexLayouts: number[], label: string): number {
  const handle = allocateHandle();
  u8(13);
  u32(handle);
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
  return handle;
}

export function createQuerySet(type: number, count: number, label: string): number {
  const handle = allocateHandle();
  u8(14);
  u32(handle);
  u32(type);
  u32(count);
  str(label);
  return handle;
}

export function createCommandEncoder(label: string): number {
  const handle = allocateHandle();
  u8(15);
  u32(handle);
  str(label);
  return handle;
}

export function beginComputePass(encoder: number, querySet: number, beginIndex: number, endIndex: number, label: string): number {
  const handle = allocateHandle();
  u8(16);
  u32(handle);
  u32(encoder);
  u32(querySet);
  u32(beginIndex);
  u32(endIndex);
  str(label);
  return handle;
}

export function computeSetPipeline(pass: number, pipeline: number): void {
  u8(17);
  u32(pass);
  u32(pipeline);
}

export function computeSetBindGroup(pass: number, index: number, bindGroup: number, dynamicOffsets: number[]): void {
  u8(18);
  u32(pass);
  u32(index);
  u32(bindGroup);
  u32Array(dynamicOffsets);
}

export function computeDispatch(pass: number, x: number, y: number, z: number): void {
  u8(19);
  u32(pass);
  u32(x);
  u32(y);
  u32(z);
}

export function computeDispatchIndirect(pass: number, buffer: number, offset: number): void {
  u8(20);
  u32(pass);
  u32(buffer);
  f64(offset);
}

export function endComputePass(pass: number): void {
  u8(21);
  u32(pass);
}

export function beginRenderPass(encoder: number, colorView: number, resolveView: number, colorLoad: number, colorStore: number, clearR: number, clearG: number, clearB: number, clearA: number, depthView: number, depthLoad: number, depthStore: number, clearDepth: number, querySet: number, beginIndex: number, endIndex: number, label: string): number {
  const handle = allocateHandle();
  u8(22);
  u32(handle);
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
  return handle;
}

export function renderSetViewport(pass: number, x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
  u8(23);
  u32(pass);
  f32(x);
  f32(y);
  f32(width);
  f32(height);
  f32(minDepth);
  f32(maxDepth);
}

export function renderSetScissor(pass: number, x: number, y: number, width: number, height: number): void {
  u8(24);
  u32(pass);
  u32(x);
  u32(y);
  u32(width);
  u32(height);
}

export function renderSetPipeline(pass: number, pipeline: number): void {
  u8(25);
  u32(pass);
  u32(pipeline);
}

export function renderSetBindGroup(pass: number, index: number, bindGroup: number, dynamicOffsets: number[]): void {
  u8(26);
  u32(pass);
  u32(index);
  u32(bindGroup);
  u32Array(dynamicOffsets);
}

export function renderSetVertexBuffer(pass: number, slot: number, buffer: number, offset: number, size: number): void {
  u8(27);
  u32(pass);
  u32(slot);
  u32(buffer);
  f64(offset);
  f64(size);
}

export function renderSetIndexBuffer(pass: number, buffer: number, format: number, offset: number, size: number): void {
  u8(28);
  u32(pass);
  u32(buffer);
  u32(format);
  f64(offset);
  f64(size);
}

export function renderDraw(pass: number, vertexCount: number, instanceCount: number, firstVertex: number, firstInstance: number): void {
  u8(29);
  u32(pass);
  u32(vertexCount);
  u32(instanceCount);
  u32(firstVertex);
  u32(firstInstance);
}

export function renderDrawIndexed(pass: number, indexCount: number, instanceCount: number, firstIndex: number, baseVertex: number, firstInstance: number): void {
  u8(30);
  u32(pass);
  u32(indexCount);
  u32(instanceCount);
  u32(firstIndex);
  i32(baseVertex);
  u32(firstInstance);
}

export function renderDrawIndirect(pass: number, buffer: number, offset: number): void {
  u8(31);
  u32(pass);
  u32(buffer);
  f64(offset);
}

export function renderDrawIndexedIndirect(pass: number, buffer: number, offset: number): void {
  u8(32);
  u32(pass);
  u32(buffer);
  f64(offset);
}

export function endRenderPass(pass: number): void {
  u8(33);
  u32(pass);
}

export function copyBufferToBuffer(encoder: number, source: number, sourceOffset: number, destination: number, destinationOffset: number, size: number): void {
  u8(34);
  u32(encoder);
  u32(source);
  f64(sourceOffset);
  u32(destination);
  f64(destinationOffset);
  f64(size);
}

export function copyBufferToTexture(encoder: number, source: number, sourceOffset: number, bytesPerRow: number, rowsPerImage: number, destination: number, mipLevel: number, originX: number, originY: number, originZ: number, aspect: number, width: number, height: number, depth: number): void {
  u8(35);
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
}

export function copyTextureToTexture(encoder: number, source: number, sourceMip: number, sourceX: number, sourceY: number, sourceZ: number, destination: number, destinationMip: number, destinationX: number, destinationY: number, destinationZ: number, width: number, height: number, depth: number): void {
  u8(36);
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
}

export function resolveQuerySet(encoder: number, querySet: number, first: number, count: number, destination: number, offset: number): void {
  u8(37);
  u32(encoder);
  u32(querySet);
  u32(first);
  u32(count);
  u32(destination);
  f64(offset);
}

export function finishCommandEncoder(encoder: number, label: string): number {
  const handle = allocateHandle();
  u8(38);
  u32(handle);
  u32(encoder);
  str(label);
  return handle;
}

export function queueSubmit(commandBuffers: number[]): void {
  u8(39);
  u32Array(commandBuffers);
}

export function writeBuffer(buffer: number, bufferOffset: number, data: UploadSlice): void {
  u8(40);
  u32(buffer);
  f64(bufferOffset);
  upload(data);
}

export function writeTexture(texture: number, mipLevel: number, originX: number, originY: number, originZ: number, aspect: number, data: UploadSlice, bytesPerRow: number, rowsPerImage: number, width: number, height: number, depth: number): void {
  u8(41);
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
}

export function configureCanvas(format: string, usage: number, alphaMode: number, colorSpace: number): void {
  u8(42);
  str(format);
  u32(usage);
  u32(alphaMode);
  u32(colorSpace);
}

export function getCurrentTexture(): number {
  const handle = allocateHandle();
  u8(43);
  u32(handle);
  return handle;
}

export function destroy(resource: number): void {
  u8(44);
  u32(resource);
  releaseHandle(resource);
}

export function mapAsync(requestId: number, buffer: number, mode: number, offset: number, size: number, destination: ReadbackSlice): void {
  u8(45);
  u32(requestId);
  u32(buffer);
  u32(mode);
  f64(offset);
  f64(size);
  readback(destination);
}

export function onSubmittedWorkDone(requestId: number): void {
  u8(46);
  u32(requestId);
}

export function requestFrame(): void {
  u8(47);
}

export function release(resource: number): void {
  u8(48);
  u32(resource);
  releaseHandle(resource);
}

export function unmap(buffer: number): void {
  u8(49);
  u32(buffer);
}

export function writeMappedBuffer(buffer: number, bufferOffset: number, data: UploadSlice): void {
  u8(50);
  u32(buffer);
  f64(bufferOffset);
  upload(data);
}
