# GPU surface

A bounded WebGPU command transport for an in-page scriptc reactor. No GPU calls or geometry uploads cross the native/page bridge. `ops.json` owns the generated guest functions, record builders, constants, host decoder, protocol identity and the generated tables in this file; `node gpu/generate.mjs --check` detects drift.

Protocol tests use a recording WebGPU double. The conformance reactor runs the same guest API on real Chrome WebGPU, on the main thread and in a dedicated worker. Desktop and mobile acceptance are tracked separately. No renderer or third-party runtime is included.

```sh
SCRIPTC=/path/to/scriptc/packages/cli/dist/main.js gpu/build.sh   # demo and conformance reactors
node gpu/generate.mjs --check
node --test gpu/verify.mjs gpu/request-errors.test.mjs
SCRIPTC=/path/to/scriptc/packages/cli/dist/main.js node gpu/encode.test.mjs
node gpu/conformance-test.mjs                  # real GPU; NT_GPU_LANES=main or worker selects one lane
NT_GPU_SKIP_MEASURE=1 node gpu/browser-test.mjs  # demo acceptance without the timing loop
```

## Memory and scheduling

The guest installs `setSink((batch, uploads, readbacks) => gpuPresent(batch, uploads, readbacks))`. The three callback arguments are borrowed views of the reactor's linear memory. `flush()` invokes that callback once, then resets command and upload cursors. Every batch starts with the generated protocol header. Upload bytes are not serialized into the command batch. The host uses `queue.writeBuffer(buffer, offset, memory.buffer, ptr, length)` and reacquires the backing memory for every upload and asynchronous readback completion.

`reserveUpload(length)` reserves an upload range; obtain its current view with `uploadView(slice)` and fill it before `flush()`. Arena growth invalidates previously obtained views; slices remain offsets, so reacquire the view after another reservation. `uploadBytes(bytes)` explicitly copies existing bytes into the arena; generate geometry directly into `uploadView` to avoid that copy. `writeBuffer` offsets and sizes must be multiples of 4 and stay inside the buffer; the target must not be mapped or mapping.

`reserveReadback(length)` reserves persistent storage; obtain data through `readbackView(slice)` after completion. The destination range belongs to the host from `mapAsync` until that request's terminal event. The host refuses a `mapAsync` whose destination overlaps a pending readback, so `resetReadbacks()` followed by a new reservation cannot overwrite bytes still in flight. A map needs an offset that is a multiple of 8 and a nonzero size that is a multiple of 4 inside the buffer and the destination slice. Readback storage is allocated on first use, bounded to 16 MiB and never relocates after reservation. Command storage is bounded to 16 MiB, uploads to 512 MiB, and descriptor arrays to 65,536 values.

The encoder validates operands as it writes them. A refused operand, array or staging limit throws, rolls back the partially written operation and returns a handle it allocated for that operation; earlier operations in the batch are unaffected.

`requestFrame()` schedules one callback to the reactor's `frame(timeMs)` export. Multiple requests coalesce. The callback must request another frame explicitly. There is no idle rAF loop. ResizeObserver and a DPR media query report size changes without polling.

Handles encode a 20-bit slot and 12-bit generation. The guest allocates them without a round trip. A slot is permanently retired after generation 4095; generations never wrap. Stale, mistyped and pending handles produce an error event. A resource whose creation failed, whose async pipeline was cancelled, or whose device was lost stays allocated: using it is an error, and `destroy`/`release` retires it normally. GPU validation errors arrive through the device's uncaptured-error event.

## Batch rejection

Batch execution is ordered, not transactional: operations before an error are not rolled back. When the host rejects an operation it emits one ERROR event and decodes the rest of the batch without executing it, except `destroy`, `release`, `requestFrame` and `cancelRequest`, which still run so guest and host handle generations stay synchronized. Each request in the skipped tail completes with its completion event and `GPU_STATUS_CANCELLED`. A malformed batch (missing or mismatched header, truncation, unknown opcode, invalid boolean or oversized array) stops decoding; its ERROR event carries `fatal: true`, and the reactor should be treated as out of protocol.

## Command recording rules

The host tracks WebGPU recording state and rejects violations synchronously instead of leaving an invalid encoder for a later uncaptured error:

- A command encoder has at most one open pass. Copies, clears, query resolution and `finishCommandEncoder` need an encoder with no open pass, and nothing records into a finished encoder.
- Pass commands after `endComputePass`/`endRenderPass` fail. Dispatches need a compute pipeline; draws need a render pipeline, and indexed draws an index buffer.
- Occlusion queries need a pass created with an occlusion query set; one query is active at a time, each index is used once per pass, and the pass cannot end with a query active.
- A command buffer is submitted at most once and may appear only once in a submission.
- `copyTextureToBuffer` needs `bytesPerRow` to be a multiple of 256; `clearBuffer` offsets and sizes are multiples of 4.
- `writeMappedBuffer` needs a buffer created mapped; `unmap` of a mapping buffer cancels its map.

## Public guest API

The public barrel is `gpu/index.ts`: it re-exports all commands, constants and record builders from `gpu/gpu.generated.ts` and exactly these staging exports from the encoder: `setSink`, `flush`, `reserveUpload`, `uploadBytes`, `uploadView`, `reserveReadback`, `readbackView`, `resetReadbacks`, and the `UploadSlice`/`ReadbackSlice` types. Offsets and sizes use nonnegative safe integers encoded as f64 where WebGPU accepts GPUSize64. Resource creation returns a u32 handle. Async creation returns the handle immediately; do not use it until PIPELINE_READY.

The `...With` operations take descriptor records (below) for multiple render targets, per-target blending and write masks, depth-stencil and stencil faces, multisampling, primitive state, vertex layouts and pipeline-overridable constants. The original single-target operations are unchanged.

<!-- generated:ops -->
| opcode | operation | result | arguments |
|---:|---|---|---|
| 1 | `requestDevice` | — | requestId: u32, powerPreference: u32, featureBits: u32, maxBufferSize: f64 |
| 2 | `createBuffer` | buffer | size: f64, usage: u32, mappedAtCreation: bool, label: str |
| 3 | `createTexture` | texture | width: u32, height: u32, depth: u32, mipLevels: u32, samples: u32, dimension: u32, format: str, usage: u32, label: str |
| 4 | `createTextureView` | textureView | texture: handle, format: str, dimension: u32, baseMip: u32, mipCount: u32, baseLayer: u32, layerCount: u32, aspect: u32, label: str |
| 5 | `createSampler` | sampler | addressU: u32, addressV: u32, addressW: u32, magFilter: u32, minFilter: u32, mipmapFilter: u32, lodMin: f32, lodMax: f32, compare: u32, maxAnisotropy: u32, label: str |
| 6 | `createShaderModule` | shaderModule | requestId: u32, code: str, label: str |
| 7 | `createBindGroupLayout` | bindGroupLayout | entries: f64[], label: str |
| 8 | `createBindGroup` | bindGroup | layout: handle, entries: f64[], label: str |
| 9 | `createPipelineLayout` | pipelineLayout | layouts: handle[], label: str |
| 10 | `createComputePipeline` | computePipeline | layout: handle, shader: handle, entry: str, label: str |
| 11 | `createComputePipelineAsync` | computePipeline | requestId: u32, layout: handle, shader: handle, entry: str, label: str |
| 12 | `createRenderPipeline` | renderPipeline | layout: handle, vertexShader: handle, vertexEntry: str, fragmentShader: handle, fragmentEntry: str, colorFormat: str, depthFormat: str, topology: u32, frontFace: u32, cullMode: u32, sampleCount: u32, depthWrite: bool, depthCompare: u32, blend: u32, vertexLayouts: f64[], label: str |
| 13 | `createRenderPipelineAsync` | renderPipeline | requestId: u32, layout: handle, vertexShader: handle, vertexEntry: str, fragmentShader: handle, fragmentEntry: str, colorFormat: str, depthFormat: str, topology: u32, frontFace: u32, cullMode: u32, sampleCount: u32, depthWrite: bool, depthCompare: u32, blend: u32, vertexLayouts: f64[], label: str |
| 14 | `createQuerySet` | querySet | type: u32, count: u32, label: str |
| 15 | `createCommandEncoder` | commandEncoder | label: str |
| 16 | `beginComputePass` | computePass | encoder: handle, querySet: handle, beginIndex: u32, endIndex: u32, label: str |
| 17 | `computeSetPipeline` | — | pass: handle, pipeline: handle |
| 18 | `computeSetBindGroup` | — | pass: handle, index: u32, bindGroup: handle, dynamicOffsets: u32[] |
| 19 | `computeDispatch` | — | pass: handle, x: u32, y: u32, z: u32 |
| 20 | `computeDispatchIndirect` | — | pass: handle, buffer: handle, offset: f64 |
| 21 | `endComputePass` | — | pass: handle |
| 22 | `beginRenderPass` | renderPass | encoder: handle, colorView: handle, resolveView: handle, colorLoad: u32, colorStore: u32, clearR: f32, clearG: f32, clearB: f32, clearA: f32, depthView: handle, depthLoad: u32, depthStore: u32, clearDepth: f32, querySet: handle, beginIndex: u32, endIndex: u32, label: str |
| 23 | `renderSetViewport` | — | pass: handle, x: f32, y: f32, width: f32, height: f32, minDepth: f32, maxDepth: f32 |
| 24 | `renderSetScissor` | — | pass: handle, x: u32, y: u32, width: u32, height: u32 |
| 25 | `renderSetPipeline` | — | pass: handle, pipeline: handle |
| 26 | `renderSetBindGroup` | — | pass: handle, index: u32, bindGroup: handle, dynamicOffsets: u32[] |
| 27 | `renderSetVertexBuffer` | — | pass: handle, slot: u32, buffer: handle, offset: f64, size: f64 |
| 28 | `renderSetIndexBuffer` | — | pass: handle, buffer: handle, format: u32, offset: f64, size: f64 |
| 29 | `renderDraw` | — | pass: handle, vertexCount: u32, instanceCount: u32, firstVertex: u32, firstInstance: u32 |
| 30 | `renderDrawIndexed` | — | pass: handle, indexCount: u32, instanceCount: u32, firstIndex: u32, baseVertex: i32, firstInstance: u32 |
| 31 | `renderDrawIndirect` | — | pass: handle, buffer: handle, offset: f64 |
| 32 | `renderDrawIndexedIndirect` | — | pass: handle, buffer: handle, offset: f64 |
| 33 | `endRenderPass` | — | pass: handle |
| 34 | `copyBufferToBuffer` | — | encoder: handle, source: handle, sourceOffset: f64, destination: handle, destinationOffset: f64, size: f64 |
| 35 | `copyBufferToTexture` | — | encoder: handle, source: handle, sourceOffset: f64, bytesPerRow: u32, rowsPerImage: u32, destination: handle, mipLevel: u32, originX: u32, originY: u32, originZ: u32, aspect: u32, width: u32, height: u32, depth: u32 |
| 36 | `copyTextureToTexture` | — | encoder: handle, source: handle, sourceMip: u32, sourceX: u32, sourceY: u32, sourceZ: u32, destination: handle, destinationMip: u32, destinationX: u32, destinationY: u32, destinationZ: u32, width: u32, height: u32, depth: u32 |
| 37 | `resolveQuerySet` | — | encoder: handle, querySet: handle, first: u32, count: u32, destination: handle, offset: f64 |
| 38 | `finishCommandEncoder` | commandBuffer | encoder: handle, label: str |
| 39 | `queueSubmit` | — | commandBuffers: handle[] |
| 40 | `writeBuffer` | — | buffer: handle, bufferOffset: f64, data: upload |
| 41 | `writeTexture` | — | texture: handle, mipLevel: u32, originX: u32, originY: u32, originZ: u32, aspect: u32, data: upload, bytesPerRow: u32, rowsPerImage: u32, width: u32, height: u32, depth: u32 |
| 42 | `configureCanvas` | — | format: str, usage: u32, alphaMode: u32, colorSpace: u32 |
| 43 | `getCurrentTexture` | texture | — |
| 44 | `destroy` | — | resource: handle |
| 45 | `mapAsync` | — | requestId: u32, buffer: handle, mode: u32, offset: f64, size: f64, destination: readback |
| 46 | `onSubmittedWorkDone` | — | requestId: u32 |
| 47 | `requestFrame` | — | — |
| 48 | `release` | — | resource: handle |
| 49 | `unmap` | — | buffer: handle |
| 50 | `writeMappedBuffer` | — | buffer: handle, bufferOffset: f64, data: upload |
| 51 | batch header (generated) | — | version: u32, identity: u32 |
| 52 | `requestDeviceWith` | — | requestId: u32, powerPreference: u32, requiredFeatures: u32, optionalFeatures: u32, limits: f64[] |
| 53 | `cancelRequest` | — | request: u32 |
| 54 | `destroyDevice` | — | — |
| 55 | `createRenderPipelineWith` | renderPipeline | layout: handle, vertexShader: handle, vertexEntry: str, fragmentShader: handle, fragmentEntry: str, targets: f64[], primitive: f64[], depthStencil: f64[], multisample: f64[], vertexLayouts: f64[], constants: f64[], label: str |
| 56 | `createRenderPipelineAsyncWith` | renderPipeline | requestId: u32, layout: handle, vertexShader: handle, vertexEntry: str, fragmentShader: handle, fragmentEntry: str, targets: f64[], primitive: f64[], depthStencil: f64[], multisample: f64[], vertexLayouts: f64[], constants: f64[], label: str |
| 57 | `createComputePipelineWith` | computePipeline | layout: handle, shader: handle, entry: str, constants: f64[], label: str |
| 58 | `createComputePipelineAsyncWith` | computePipeline | requestId: u32, layout: handle, shader: handle, entry: str, constants: f64[], label: str |
| 59 | `beginRenderPassWith` | renderPass | encoder: handle, colors: f64[], depthStencil: f64[], occlusionQuerySet: handle, timestampQuerySet: handle, beginIndex: u32, endIndex: u32, label: str |
| 60 | `renderSetStencilReference` | — | pass: handle, reference: u32 |
| 61 | `renderSetBlendConstant` | — | pass: handle, r: f64, g: f64, b: f64, a: f64 |
| 62 | `renderBeginOcclusionQuery` | — | pass: handle, index: u32 |
| 63 | `renderEndOcclusionQuery` | — | pass: handle |
| 64 | `copyTextureToBuffer` | — | encoder: handle, source: handle, mipLevel: u32, originX: u32, originY: u32, originZ: u32, aspect: u32, destination: handle, offset: f64, bytesPerRow: u32, rowsPerImage: u32, width: u32, height: u32, depth: u32 |
| 65 | `clearBuffer` | — | encoder: handle, buffer: handle, offset: f64, size: f64 |
<!-- /generated:ops -->

## Protocol identity

<!-- generated:protocol -->
Protocol version 2, identity `0x49f0fe82` (FNV-1a of `gpu/ops.json`). Every batch starts with the 9-byte header: opcode 51, u32 version, u32 identity, little-endian.
<!-- /generated:protocol -->

The guest encoder writes the header into every batch, and the host refuses a batch whose version or identity differs from its generated decoder. The CAPABILITIES event reports the host's `protocol: { version, identity }`; the guest exposes `GPU_PROTOCOL_VERSION` and `GPU_PROTOCOL_IDENTITY`. Host-side tools that build batches use `writeGpuProtocolHeader(bytes, offset)` from `gpu-host.generated.js`.

## Completion events

The host emits `{ type, requestId, handle, status, ...data }` on a later microtask, never during the `gpuPresent` import. Error events carry `message`; shader information carries compilation messages with `lineNum`, `linePos`, `offset` and `length`. No adapter is a reported capability result, not an exception.

Every request id accepted or rejected by the host completes exactly once, unless the host is disposed, which suppresses all later events. The terminal event is the request's completion event with a status, or ERROR when the request is rejected or fails. The id is released before the event is delivered, so the handler may reuse it. Request ids are nonzero; at most 1024 are pending. Reusing a pending id is reported as ERROR with `requestId` 0 and `duplicateRequestId`, and the original request still completes once.

- `cancelRequest(id)` completes a pending request immediately with `GPU_STATUS_CANCELLED`. Cancelling a completed or unknown id does nothing. A cancelled map is unmapped; a cancelled device request destroys a device that arrives late; a cancelled async pipeline handle stays unusable until retired.
- Retiring a buffer with a pending map, or an async pipeline handle before PIPELINE_READY, cancels that request.
- On device loss, by the browser or through `destroyDevice()`, every pending request completes with `GPU_STATUS_LOST`, in issue order, before DEVICE_LOST is delivered. Frame callbacks are cancelled, the canvas must be configured again, and every existing handle is lost. Call `requestDevice` or `requestDeviceWith` again after DEVICE_LOST to restart. A request whose WebGPU promise rejects at the moment of an external loss may complete with ERROR instead of LOST.

<!-- generated:events -->
| code | event | terminal |
|---:|---|---|
| 1 | CAPABILITIES | yes |
| 2 | PIPELINE_READY | yes |
| 3 | MAP_READY | yes |
| 4 | WORK_DONE | yes |
| 5 | DEVICE_LOST | no |
| 6 | UNCAUGHT_ERROR | no |
| 7 | SHADER_INFO | yes |
| 8 | RESIZE | no |
| 9 | ERROR | yes |
<!-- /generated:events -->

<!-- generated:statuses -->
| status | name |
|---:|---|
| 0 | `GPU_STATUS_OK` |
| 1 | `GPU_STATUS_ERROR` |
| 2 | `GPU_STATUS_CANCELLED` |
| 3 | `GPU_STATUS_LOST` |
<!-- /generated:statuses -->

<!-- generated:requests -->
| operation | completion event | executes after a rejected operation in the same batch |
|---|---|---|
| `requestDevice` | CAPABILITIES | no; completes with CANCELLED |
| `createShaderModule` | SHADER_INFO | no; completes with CANCELLED |
| `createComputePipelineAsync` | PIPELINE_READY | no; completes with CANCELLED |
| `createRenderPipelineAsync` | PIPELINE_READY | no; completes with CANCELLED |
| `destroy` | — | yes |
| `mapAsync` | MAP_READY | no; completes with CANCELLED |
| `onSubmittedWorkDone` | WORK_DONE | no; completes with CANCELLED |
| `requestFrame` | — | yes |
| `release` | — | yes |
| `requestDeviceWith` | CAPABILITIES | no; completes with CANCELLED |
| `cancelRequest` | — | yes |
| `createRenderPipelineAsyncWith` | PIPELINE_READY | no; completes with CANCELLED |
| `createComputePipelineAsyncWith` | PIPELINE_READY | no; completes with CANCELLED |
<!-- /generated:requests -->

## Descriptor records

Descriptor arrays are flat f64 records; `record<Name>(out, ...fields)` appends one record to `out` and returns it. Bind group layout entries: binding, visibility, kind, type, dynamicOffset, minBindingSize, viewDimension, multisampled, storageFormat, storageAccess. Bind group entries: binding, kind, resourceHandle, offset, size (zero means remaining buffer). Pipeline vertex buffers are stride, stepMode, attributeCount followed by attributeCount triples of shaderLocation, offset, format; strides are multiples of 4 and shader locations are unique, within the device's vertex limits.

In `...With` operations, enum value 0 means the WebGPU default, except that a colour target or colour attachment with format or view 0 is a sparse `null` slot. `colorAttachment.depthSlicePlusOne` is the 3D slice plus one, or 0 to omit it. Single-record arrays (primitive, depthStencil, multisample, depthStencilAttachment) are empty to use the defaults. `constant` records apply to the shader stages in `stages` (`SHADER_STAGE_*` bits) and key WGSL `@id(n)` overrides. Record widths and enum values are bounded protocol contracts; unknown values fail closed.

<!-- generated:records -->
| record | width | fields |
|---|---:|---|
| `bindGroupLayout` (`recordBindGroupLayout`) | 10 | binding, visibility, kind, type, dynamic, minSize, dimension, multisampled, format, access |
| `bindGroup` (`recordBindGroup`) | 5 | binding, kind, resource, offset, size |
| `vertexBuffer` (`recordVertexBuffer`) | 3 | arrayStride, step, attributeCount |
| `vertexAttribute` (`recordVertexAttribute`) | 3 | shaderLocation, offset, format |
| `colorTarget` (`recordColorTarget`) | 9 | format, writeMask, blend, colorOperation, colorSrcFactor, colorDstFactor, alphaOperation, alphaSrcFactor, alphaDstFactor |
| `primitive` (`recordPrimitive`) | 5 | topology, stripIndexFormat, frontFace, cullMode, unclippedDepth |
| `depthStencil` (`recordDepthStencil`) | 16 | format, depthWrite, depthCompare, frontCompare, frontFail, frontDepthFail, frontPass, backCompare, backFail, backDepthFail, backPass, stencilReadMask, stencilWriteMask, depthBias, depthBiasSlopeScale, depthBiasClamp |
| `multisample` (`recordMultisample`) | 3 | count, mask, alphaToCoverage |
| `colorAttachment` (`recordColorAttachment`) | 9 | view, resolveView, load, store, clearR, clearG, clearB, clearA, depthSlicePlusOne |
| `depthStencilAttachment` (`recordDepthStencilAttachment`) | 9 | view, depthLoad, depthStore, depthClear, depthReadOnly, stencilLoad, stencilStore, stencilClear, stencilReadOnly |
| `limitRequest` (`recordLimitRequest`) | 3 | limit, value, mode |
| `constant` (`recordConstant`) | 3 | stages, id, value |
<!-- /generated:records -->

<!-- generated:enums -->
| enum | constants | values |
|---|---|---|
| `dimension` | `DIMENSION_*` | 1 1d, 2 2d, 3 3d |
| `view` | `VIEW_*` | 1 1d, 2 2d, 3 2d-array, 4 cube, 5 cube-array, 6 3d |
| `address` | `ADDRESS_*` | 0 clamp-to-edge, 1 repeat, 2 mirror-repeat |
| `filter` | `FILTER_*` | 0 nearest, 1 linear |
| `compare` | `COMPARE_*` | 1 never, 2 less, 3 equal, 4 less-equal, 5 greater, 6 not-equal, 7 greater-equal, 8 always |
| `topology` | `TOPOLOGY_*` | 1 point-list, 2 line-list, 3 line-strip, 4 triangle-list, 5 triangle-strip |
| `front` | `FRONT_FACE_*` | 1 ccw, 2 cw |
| `cull` | `CULL_*` | 0 none, 1 front, 2 back |
| `load` | `LOAD_*` | 1 load, 2 clear |
| `store` | `STORE_*` | 1 store, 2 discard |
| `aspect` | `ASPECT_*` | 0 all, 1 stencil-only, 2 depth-only |
| `buffer` | `BUFFER_BINDING_*` | 1 uniform, 2 storage, 3 read-only-storage |
| `sampler` | `SAMPLER_*` | 1 filtering, 2 non-filtering, 3 comparison |
| `sample` | `TEXTURE_SAMPLE_*` | 1 float, 2 unfilterable-float, 3 depth, 4 sint, 5 uint |
| `access` | `STORAGE_*` | 1 write-only, 2 read-only, 3 read-write |
| `format` | `FORMAT_*` | 1 rgba8unorm, 2 bgra8unorm, 3 rgba16float, 4 r32float, 5 r32uint, 6 rg32float, 7 rgba32float, 8 depth24plus, 9 depth32float, 10 r8unorm, 11 r8snorm, 12 r8uint, 13 r8sint, 14 r16uint, 15 r16sint, 16 r16float, 17 rg8unorm, 18 rg8snorm, 19 rg8uint, 20 rg8sint, 21 r32sint, 22 rg16uint, 23 rg16sint, 24 rg16float, 25 rgba8unorm-srgb, 26 rgba8snorm, 27 rgba8uint, 28 rgba8sint, 29 bgra8unorm-srgb, 30 rgb10a2uint, 31 rgb10a2unorm, 32 rg11b10ufloat, 33 rgb9e5ufloat, 34 rg32uint, 35 rg32sint, 36 rgba16uint, 37 rgba16sint, 38 rgba32uint, 39 rgba32sint, 40 stencil8, 41 depth16unorm, 42 depth24plus-stencil8, 43 depth32float-stencil8 |
| `vertexFormat` | `VERTEX_FORMAT_*` | 1 float32, 2 float32x2, 3 float32x3, 4 float32x4, 5 uint32, 6 uint32x2, 7 uint32x3, 8 uint32x4, 9 sint32, 10 sint32x2, 11 sint32x3, 12 sint32x4, 13 unorm8x4, 14 uint8, 15 uint8x2, 16 uint8x4, 17 sint8, 18 sint8x2, 19 sint8x4, 20 unorm8, 21 unorm8x2, 22 snorm8, 23 snorm8x2, 24 snorm8x4, 25 uint16, 26 uint16x2, 27 uint16x4, 28 sint16, 29 sint16x2, 30 sint16x4, 31 unorm16, 32 unorm16x2, 33 unorm16x4, 34 snorm16, 35 snorm16x2, 36 snorm16x4, 37 float16, 38 float16x2, 39 float16x4, 40 unorm10-10-10-2, 41 unorm8x4-bgra |
| `index` | `INDEX_*` | 1 uint16, 2 uint32 |
| `step` | `STEP_*` | 0 vertex, 1 instance |
| `blendFactor` | `BLEND_FACTOR_*` | 1 zero, 2 one, 3 src, 4 one-minus-src, 5 src-alpha, 6 one-minus-src-alpha, 7 dst, 8 one-minus-dst, 9 dst-alpha, 10 one-minus-dst-alpha, 11 src-alpha-saturated, 12 constant, 13 one-minus-constant, 14 src1, 15 one-minus-src1, 16 src1-alpha, 17 one-minus-src1-alpha |
| `blendOperation` | `BLEND_OP_*` | 1 add, 2 subtract, 3 reverse-subtract, 4 min, 5 max |
| `stencilOperation` | `STENCIL_OP_*` | 1 keep, 2 zero, 3 replace, 4 invert, 5 increment-clamp, 6 decrement-clamp, 7 increment-wrap, 8 decrement-wrap |
| `queryType` | `QUERY_TYPE_*` | 1 timestamp, 2 occlusion |
| `limitMode` | `LIMIT_MODE_*` | 1 required, 2 preferred |
| `power` | `POWER_*` | 0 low-power, 1 high-performance |
<!-- /generated:enums -->

## Negotiation

`requestDeviceWith(requestId, power, requiredFeatures, optionalFeatures, limits)` takes `FEATURE_*` bit sets and `limitRequest` records of limit id, value and mode. A required feature or limit the adapter lacks completes CAPABILITIES with status ERROR, `available: false`, `missingFeatures`, `missingFeatureBits` and `missingLimits`, and no device is created. Optional features are enabled when the adapter has them. `LIMIT_MODE_PREFERRED` requests the value clamped to the adapter: the smaller of the two for maximum limits and the larger for alignments, which must be powers of two. Success reports `features`/`featureBits`, `adapterFeatures`/`adapterFeatureBits`, the device `limits`, `adapterLimits`, the preferred canvas `format` and its `formatCode`, and `protocol`. `requestDevice` remains available: its timestamp bit is optional and a nonzero `maxBufferSize` is a required limit.

<!-- generated:features -->
| bit value | feature |
|---:|---|
| 1 | `timestamp-query` |
| 2 | `depth-clip-control` |
| 4 | `depth32float-stencil8` |
| 8 | `texture-compression-bc` |
| 16 | `texture-compression-bc-sliced-3d` |
| 32 | `texture-compression-etc2` |
| 64 | `texture-compression-astc` |
| 128 | `texture-compression-astc-sliced-3d` |
| 256 | `indirect-first-instance` |
| 512 | `shader-f16` |
| 1024 | `rg11b10ufloat-renderable` |
| 2048 | `bgra8unorm-storage` |
| 4096 | `float32-filterable` |
| 8192 | `float32-blendable` |
| 16384 | `clip-distances` |
| 32768 | `dual-source-blending` |
| 65536 | `subgroups` |
| 131072 | `core-features-and-limits` |
| 262144 | `primitive-index` |
| 524288 | `texture-formats-tier1` |
| 1048576 | `texture-formats-tier2` |
<!-- /generated:features -->

<!-- generated:limits -->
| id | limit | class |
|---:|---|---|
| 1 | `maxTextureDimension1D` | maximum |
| 2 | `maxTextureDimension2D` | maximum |
| 3 | `maxTextureDimension3D` | maximum |
| 4 | `maxTextureArrayLayers` | maximum |
| 5 | `maxBindGroups` | maximum |
| 6 | `maxBindGroupsPlusVertexBuffers` | maximum |
| 7 | `maxBindingsPerBindGroup` | maximum |
| 8 | `maxDynamicUniformBuffersPerPipelineLayout` | maximum |
| 9 | `maxDynamicStorageBuffersPerPipelineLayout` | maximum |
| 10 | `maxSampledTexturesPerShaderStage` | maximum |
| 11 | `maxSamplersPerShaderStage` | maximum |
| 12 | `maxStorageBuffersPerShaderStage` | maximum |
| 13 | `maxStorageTexturesPerShaderStage` | maximum |
| 14 | `maxUniformBuffersPerShaderStage` | maximum |
| 15 | `maxUniformBufferBindingSize` | maximum |
| 16 | `maxStorageBufferBindingSize` | maximum |
| 17 | `minUniformBufferOffsetAlignment` | alignment |
| 18 | `minStorageBufferOffsetAlignment` | alignment |
| 19 | `maxVertexBuffers` | maximum |
| 20 | `maxBufferSize` | maximum |
| 21 | `maxVertexAttributes` | maximum |
| 22 | `maxVertexBufferArrayStride` | maximum |
| 23 | `maxInterStageShaderVariables` | maximum |
| 24 | `maxColorAttachments` | maximum |
| 25 | `maxColorAttachmentBytesPerSample` | maximum |
| 26 | `maxComputeWorkgroupStorageSize` | maximum |
| 27 | `maxComputeInvocationsPerWorkgroup` | maximum |
| 28 | `maxComputeWorkgroupSizeX` | maximum |
| 29 | `maxComputeWorkgroupSizeY` | maximum |
| 30 | `maxComputeWorkgroupSizeZ` | maximum |
| 31 | `maxComputeWorkgroupsPerDimension` | maximum |
<!-- /generated:limits -->

## Scope

Not implemented: render bundles, external textures, MAP_WRITE `mapAsync`, texture `viewFormats`, debug groups and markers, multi-draw indirect, and `getBindGroupLayout` for `"auto"` layouts (use explicit layouts). Format operands of the original operations remain strings; records use the generated `FORMAT_*` enum.

## Measurements

| workload | transport | direct JS |
|---|---|---|
| setScissor operations/ms | 25,000 | 50,000 |
| 500-op decode/calls | 0.020 ms | 0.010 ms |
| 16 MiB writeBuffer | 0.230 ms | 0.230 ms |

Chrome 154.0.8037.98 headless, Apple M4 Max/macOS arm64, 101 paired/interleaved trials after 20 warmups. COOP/COEP enables the higher-resolution timer. The decoder benchmark replays real WebGPU calls, excluding command encoding and encoder/pass creation; it is not end-to-end engine time. Uploads use the same reactor memory, same queue and same destination; allocation and filling are excluded on both sides. These are CPU API-call times: queue completion is awaited between pairs but is outside the timed samples. `gpu/browser-test.mjs` prints fresh numbers; `NT_RECORD_GPU=1` records `gpu/last-run.json`. Recent 500-op medians ranged from 0.020 to 0.030 ms. These figures predate protocol version 2. The browser gate also verifies presented triangle/background pixels, forces linear-memory growth after a frame has begun encoding, and checks real device loss and line-numbered shader diagnostics. The demo draws compute-generated vertex positions from the storage buffer and verified all 1,024 readback words and reported a compute timestamp of 7,916 ns in the initial run; GPU timestamps vary between runs.
