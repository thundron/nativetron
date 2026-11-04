# GPU surface

A bounded WebGPU command transport for an in-page scriptc reactor. No GPU calls or geometry uploads cross the native/page bridge. `ops.json` owns the generated guest functions and decoder; `node gpu/generate.mjs --check` detects drift.

Browser acceptance passes on real Chrome WebGPU. Desktop and mobile acceptance are tracked separately. No renderer or third-party runtime is included.

```sh
gpu/build.sh
node --test gpu/verify.mjs
node gpu/browser-test.mjs
```

## Memory and scheduling

The guest installs `setSink((batch, uploads, readbacks) => gpuPresent(batch, uploads, readbacks))`. The three callback arguments are borrowed views of the reactor's linear memory. `flush()` invokes that callback once, then resets command and upload cursors. Upload bytes are not serialized into the command batch. The host uses `queue.writeBuffer(buffer, offset, memory.buffer, ptr, length)` and reacquires the backing memory for every upload and asynchronous readback completion.

`reserveUpload(length)` reserves an upload range; obtain its current view with `uploadView(slice)` and fill it before `flush()`. Arena growth invalidates previously obtained views; slices remain offsets, so reacquire the view after another reservation. `uploadBytes(bytes)` explicitly copies existing bytes into the arena; generate geometry directly into `uploadView` to avoid that copy. `reserveReadback(length)` reserves persistent storage; obtain data through `readbackView(slice)` after completion. Keep it allocated until the corresponding completion event. Request ids are nonzero and unique while pending; at most 1024 async requests are outstanding.

`requestFrame()` schedules one callback to the reactor's `frame(timeMs)` export. Multiple requests coalesce. The callback must request another frame explicitly. There is no idle rAF loop. ResizeObserver and a DPR media query report size changes without polling.

Readback storage is allocated on first use, bounded to 16 MiB and never relocates after reservation; `resetReadbacks()` is valid only after all pending readbacks complete. Command storage is bounded to 16 MiB, uploads to 512 MiB, and descriptor arrays to 65,536 values.

Handles encode a 20-bit slot and 12-bit generation. The guest allocates them without a round trip. A slot is permanently retired after generation 4095; generations never wrap. Stale, mistyped and pending handles produce an error event and abort the batch. GPU validation errors arrive through the device's uncaptured-error event. Batch execution is ordered, not transactional: operations before an error are not rolled back.

## Public guest API

Import commands and constants from `gpu/gpu.generated.ts`; import staging and `setSink`/`flush` from `gpu/encode.ts`. Offsets and sizes use nonnegative safe integers encoded as f64 where WebGPU accepts GPUSize64. Resource creation returns a u32 handle. Async creation returns the handle immediately; do not use it until PIPELINE_READY.

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
<!-- /generated:ops -->

## Completion events

The host emits `{ type, requestId, handle, status, ...data }`. Status zero means success. Error events carry `message`; shader information carries compilation messages with `lineNum`, `linePos`, `offset` and `length`. Capability events carry availability, enabled/adapter features, selected format and device limits. No adapter is a reported capability result, not an exception.

<!-- generated:events -->
| code | event |
|---:|---|
| 1 | CAPABILITIES |
| 2 | PIPELINE_READY |
| 3 | MAP_READY |
| 4 | WORK_DONE |
| 5 | DEVICE_LOST |
| 6 | UNCAUGHT_ERROR |
| 7 | SHADER_INFO |
| 8 | RESIZE |
| 9 | ERROR |
<!-- /generated:events -->

## Descriptor records

Bind group layout entries are ten f64 values: binding, visibility, kind, type, dynamicOffset, minBindingSize, viewDimension, multisampled, storageFormat, storageAccess. Bind group entries are five f64 values: binding, kind, resourceHandle, offset, size (zero means remaining buffer). Pipeline vertex buffer records are stride, stepMode, attributeCount followed by attributeCount triples of shaderLocation, offset, format. Record widths and enum values are bounded protocol contracts; unknown values fail closed.

Current render-pass scope is one colour attachment plus optional depth and resolve views. Current render-pipeline scope is one colour target, optional depth, configurable vertex buffers, no blending or standard source-alpha blending. `mapAsync` supports readback only; mapped-at-creation writes use `writeMappedBuffer` then `unmap`. `destroy` invokes the underlying destroy method where available; `release` only retires the protocol handle (required for presentation textures). Stencil operations, texture-to-buffer copies, bundles and arbitrary blend descriptors are not implemented.

## Measurements

| workload | transport | direct JS |
|---|---|---|
| setScissor operations/ms | 16,667 | 50,000 |
| 500-op decode/calls | 0.030 ms | 0.010 ms |
| 16 MiB writeBuffer | 0.315 ms | 0.315 ms |

Chrome 154.0.8037.98 headless, Apple M4 Max/macOS arm64, 101 paired/interleaved trials after 20 warmups. COOP/COEP enables the higher-resolution timer. The decoder benchmark replays real WebGPU calls, excluding command encoding and encoder/pass creation; it is not end-to-end engine time. Uploads use the same reactor memory, same queue and same destination; allocation and filling are excluded on both sides. `gpu/browser-test.mjs` prints fresh numbers; `NT_RECORD_GPU=1` records `gpu/last-run.json`. Recent 500-op medians ranged from 0.025 to 0.030 ms. The browser gate also verifies presented triangle/background pixels, forces linear-memory growth after a frame has begun encoding, and checks real device loss and line-numbered shader diagnostics. The demo draws compute-generated vertex positions from the storage buffer and verified all 1,024 readback words and reported a compute timestamp of 7,916 ns in the initial run; GPU timestamps vary between runs.
