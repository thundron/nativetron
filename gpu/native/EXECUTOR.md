# Native protocol-3 executor (`executor.h` / `executor.cc`)

The native twin of `gpu/host.js`: it executes the reactor's GPU op stream (protocol 3, `gpu/ops.json`) on wgpu-native
through the `ntgpu` facade, behind the shared C contract in `executor.h`. The batch is decoded only by the generated
`gpu/native-decoder.generated.h`; the executor is its template visitor, so all 64 operations (65 with the protocol
header) have a handler and a schema change is a compile error. The JS host, `ops.json`, the guest API and
`gpu/generate.mjs` are unchanged. macOS arm64 (Metal) only; no Dawn.

| file | role |
|---|---|
| `executor.h` | shared embedding contract (unchanged; owned jointly with the reactor and macOS host lanes) |
| `executor.cc` | the executor: handle table, requests, negotiation, every operation, canvas/surface, capture |
| `executor-test.h` | test-only hooks: external device loss, native poll count, live handle count |
| `build-executor.sh` | builds `libntgpu-executor.a` and the drivers outside the worktree |
| `executor-driver.cc`, `executor-layer-darwin.mm` | line-protocol driver (the embedding role) for tests and the corpus run |
| `executor-client.mjs` | Node client: encodes `[operation, ...operands]` like the generated guest functions |
| `executor.test.mjs` | real-device protocol, compute, texture, canvas, surface, arena, idle and stress tests |
| `executor-conformance.cc`, `executor-conformance.test.mjs` | `gpu/conformance.ts` compiled natively by scriptc, run on the executor, checked with `gpu/conformance-test.mjs`'s assertions |
| `executor-corpus.mjs` | runs a captured WGSL corpus (manifest + modules) through protocol operations |

## Embedding contract (as implemented)

- **Threads.** Every call except `wake` comes from one owner thread. Callbacks run on that thread, inside
  `submit`/`process`/`resize`/`capture`, and must only enqueue (never call guest exports). `wake` may run on any thread.
- **submit.** Decodes and executes the batch synchronously. Uploads are consumed during the call
  (`wgpuQueueWriteBuffer`/`WriteTexture` copy, mapped writes are `memcpy`); the command and upload pointers are not
  retained. Readbacks are described by `readback_capacity` only: `mapAsync` destinations are bounds-checked and leased
  against it, and the bytes arrive with `MAP_READY` (borrowed until `event()` returns; the embedding copies them into
  the guest arena with its `readback(offset, bytes)` export before delivering the event). Arenas above
  `kMaxUploadBytes` (512 MiB) or `kMaxReadbackBytes` (16 MiB) are refused with a fatal `ERROR`. Returns the JS
  `apply()` value: 1 when no operation was rejected.
- **Completion timing.** Like the JS host's microtasks, the completions of a batch's shader modules
  (`SHADER_INFO`), async pipelines (`PIPELINE_READY`/`ERROR`) and device requests (`CAPABILITIES`) are emitted at the
  end of that `submit`, after every operation ran (so a later `cancelRequest`/`destroy` in the same batch wins).
  Native completions — `MAP_READY`, `WORK_DONE`, `UNCAUGHT_ERROR`, a native `DEVICE_LOST` — are emitted only by
  `process()`.
- **process / pending / wake.** `pending()` counts unsettled requests plus queued native events. While a map or
  work-done is outstanding, a waiter thread blocks in `wgpuDevicePoll(wait)` (no spinning; a bounded 1–64 ms back-off
  only if a poll completes nothing) and the facade calls `wake` when its event queue turns non-empty; the owner then
  calls `process()`, which also does one non-blocking poll. With nothing outstanding the waiter sleeps on a condition
  variable: zero polls, zero wakes (tested). A host that prefers polling may simply call `process()` per frame while
  `pending() > 0`.
- **Map-state serialization.** wgpu-core's poll-side mapping races with an unmap/map of the same buffer on another
  thread ("Buffer is already mapped" under load). Map, unmap, mapped-range access, buffer release/destroy and device
  request/release therefore take the same mutex as the waiter's blocking poll; such a call can wait until
  already-submitted GPU work finishes. Not measured; a performance follow-up if per-frame readbacks matter.
- **Submission guard.** wgpu-native's `wgpuQueueSubmit` turns *every* submit error into a Rust panic across
  `extern "C"`, i.e. a process abort (verified: an invalid recorded pipeline, a copy out of range, a destroyed buffer
  or texture — directly or behind a bind group — and a buffer mapped or pending a map all abort). WebGPU instead
  raises a validation error and executes nothing of that submission. The executor therefore wraps `finish()` in an
  error scope (an encoder error marks the command buffer invalid and is re-raised as `UNCAUGHT_ERROR`, as a browser
  reports it at `finish()`), records the buffers, textures (through views and canvas textures), query sets and bind
  group resources every encoder and pass uses, and before `wgpuQueueSubmit` refuses a submission containing an
  invalid command buffer, a destroyed resource or a mapped/map-pending buffer: one `UNCAUGHT_ERROR`, nothing executed,
  command buffers marked submitted. A submission on a device the facade already knows to be lost is dropped silently
  (the loss arrives through `process()`). Synthesized uncaptured errors are queued through `ntgpu_report_error`, in
  order with wgpu-native's own.
- **Frames.** `requestFrame` (ignored without a device, as in the JS host) calls `frame_requested` once at the end of
  the submit; the embedding coalesces until it runs the guest's frame export.
- **Resize.** `resize(width, height, pixel_ratio)` takes drawable *device pixels* (the macOS host's
  `max(1, round(css * dpr))`) and emits `RESIZE {width,height,dpr}` once per distinct triple (also after device
  creation, like `pixels()`); the embedding must not emit its own RESIZE.
- **Canvas.** Headless (no `metal_layer`): `configureCanvas` + `getCurrentTexture` return a real texture of the
  current size with the configured format and usage plus `RENDER_ATTACHMENT|COPY_SRC`; it persists between frames
  (not cleared like a browser canvas swap) and is recreated on resize. With a `CAMetalLayer` lease: a surface is made
  on `configureCanvas` (Fifo, alpha opaque/premultiplied), reconfigured when the size changed, one surface texture is
  acquired per frame (repeated `getCurrentTexture` share it) and presented at the end of the submit that submitted
  work after acquiring it. Loss releases the surface; the layer stays leased until `ntgpu_executor_destroy` returns.
- **capture_rgba.** Synchronous, outside guest exports: copies the headless canvas texture, waits for that map only,
  and writes RGBA8 rows top-left first (BGRA canvases are swizzled). Unavailable (returns 0 with an `ERROR` event
  carrying `capture: true`) without a device, before a canvas texture exists, with a `CAMetalLayer` surface, for
  formats other than (b|r)gba8unorm(-srgb), or with a short buffer (width/height are still written).
- **destroy.** Joins the waiter (after in-flight GPU work), destroys every live resource, releases the surface, then
  the device; no event is delivered from or after destroy.

## Parity with `gpu/host.js`

Same handle table (20-bit slot, 12-bit generation, reservation rules, retirement without a resource, generation 4095
retires the slot forever, lost handles stay allocated until retired, failed creations stay allocated), same request
rules (ids nonzero and unique among pending, at most 1024, exactly one terminal event, `settle` removes the id before
the event, cancellation via `cancelRequest`/`unmap`/`destroy`/`release`, `LOST` before `DEVICE_LOST`), the same batch
rules through the generated decoder (fatal vs rejected, skipped requests `CANCELLED`, control operations still run,
`duplicateRequestId`), the same recording state machine and descriptor validation, and the same rejection texts.
Events have the JS shapes and key order: `{type, requestId, handle, status, ...}`; CAPABILITIES carries
`available, features, featureBits, adapterFeatures, adapterFeatureBits, limits, adapterLimits, format ("bgra8unorm"),
formatCode, protocol` (or the refusal fields), SHADER_INFO `messages[{message,type,lineNum,linePos,offset,length}]`.

Deliberate differences (each forced by wgpu-native or by the native embedding):
- Async pipelines are created synchronously at their operation (wgpu-native's async creation aborts), inside
  validation/OOM scopes; the submit blocks for Naga → MSL → Metal. Failures complete as `ERROR` with the Naga message.
- `SHADER_INFO` has at most one message, recovered from the Naga report (`ntgpu_wgsl_location`); no warnings
  (`getCompilationInfo` aborts in wgpu-native).
- Limits objects list the 31 protocol limits (a browser lists more); `maxBindGroupsPlusVertexBuffers`, undefined in
  wgpu-native, is reported as the WebGPU default 24 and not requested. A requested limit worse than the WebGPU
  default is upgraded to the default, as WebGPU does. Feature lists contain standard names only.
- Query sets are only released (wgpu-native's `wgpuQuerySetDestroy` drops the id and a later release panics).
  Canvas textures are released, not destroyed. `unmap` of an unmapped buffer is a no-op (wgpu-native would raise a
  validation error). Labels are passed in descriptors only.
- WebGPU `TypeError`s become rejections with protocol-style texts (for example `unsupported GPU texture format "x"`).
- Timestamps resolve but WebGPU gives no ordering guarantee; on this Mac render-pass pairs were once seen reversed.

## Build and link

```sh
gpu/native/build-executor.sh                         # → $NT_NATIVE_GPU_DEPS/build/macos-arm64-executor (last stdout line)
gpu/native/build-executor.sh --sanitize address      # or thread; separate default directory
SCRIPTC=…/scriptc/packages/cli/dist/main.js gpu/native/build-executor.sh --conformance
NTGPU_WGPU_LIB=/path/to/patched/libwgpu_native.a gpu/native/build-executor.sh   # e.g. a Naga-fixed wgpu-native
```

`NT_NATIVE_GPU_DEPS` selects the dependency cache (verified with `fetch-deps.sh --offline`, fetched only if absent),
`NTGPU_EXECUTOR_BUILD_DIR` the output (refused inside the worktree). Link an embedding with
`libntgpu-executor.a <prefix>/lib/libwgpu_native.a -framework Metal -framework QuartzCore -framework Foundation
-framework CoreFoundation -lobjc -liconv -lc++` (C++17 inside, C ABI outside). `libntgpu-executor.a` contains
`executor.o` and `ntgpu.o`; do not also link `libntgpu.a`.

## Tests and evidence (this Mac: macOS 27.0.1, Apple M4 Max, Metal, wgpu-native v29.0.1.1)

```sh
node --test gpu/native/executor.test.mjs                       # 20 tests, real device (NTGPU_SHADER_CORPUS=dir adds the corpus run)
SCRIPTC=… node --test gpu/native/executor-conformance.test.mjs # conformance reactor, native, real device
NTGPU_EXECUTOR_SANITIZE=address node --test gpu/native/executor.test.mjs gpu/native/executor-conformance.test.mjs
NTGPU_EXECUTOR_SANITIZE=thread  node --test gpu/native/executor.test.mjs gpu/native/executor-conformance.test.mjs
node gpu/native/executor-corpus.mjs --corpus <dir with manifest.json and wgsl/> --driver <build>/ntgpu-executor-driver --out report.json
```

- `executor.test.mjs`: the submission guard (seven cases that abort a bare wgpu-native process stay alive, report
  `UNCAUGHT_ERROR` and keep the device usable), fatal/rejected batches, skipped requests, generation retirement at 4095, stale/wrong-kind/
  failed handles, readback bounds and leases, guest and external loss, restart, map cancellation by
  `cancelRequest`/`unmap`/`destroy`, async pipeline cancel/release/failure, duplicate ids and the 1024 limit,
  negotiation statuses and clamping, Naga diagnostics, the recording state machine, record validation, a 16 MiB
  upload → copy → 16 MiB readback (content hash), refused arena sizes, idle (no polls/wakes), a CAMetalLayer surface,
  a seeded random cancel/unmap/destroy/loss stress run, and one test that executes **every one of the 64 operations**
  on the device and checks exact results: four override-constant compute passes (`6i+16`), indirect dispatch and
  draws, texture upload/copies, sampled textured quads, a stencil-tested pass with blend constants, occlusion and
  timestamp resolves, `clearBuffer`, a headless bgra8unorm canvas captured as RGBA top-left, resize, and restart.
- Conformance: `CONF_DEVICE 1 | CONF_READY | CONF_RENDER_OK 1 | CONF_LOST 0 | CONF_RESTART_OK | CONF_LOST 0`, all
  `conformance-test.mjs` assertions, no `UNCAUGHT_ERROR`. The occlusion count is 1 (Metal's visibility result is
  boolean-like); the test requires a nonzero count, as in the browser lanes.
- ASan+UBSan and TSan builds pass the same tests with no reports from the executor/facade C++ (Rust is not
  instrumented).
- house-planner corpus (`/tmp/nt-native-gpu-shaders-20261113`, 199 modules): 187 modules compile; 810 pipelines
  (801 compute, 9 render) from the recorded entry points × override sets × bind-group layouts × render states,
  786 ready; no uncaught errors, no loss. The 24 failures are exactly the shader lane's Naga 29 results: 12
  `gi.insert` modules ("Function 'insertKey' is invalid: Returning None where Some is expected") and the 12
  `gi.merge` pipelines with override `0 = 4` ("ConstantEvaluatorError(InvalidAccessIndex)"). Both are front-end
  issues of the consumer's shaders on Naga, not executor issues. Linked through `NTGPU_WGPU_LIB` against the
  Naga-fix lane's build in the shared cache (`wgpu-native/v29.0.1.1+naga-wgsl-compat.1`, same `webgpu.h`), the same
  run gives 199/199 modules and 810/810 pipelines, and the conformance reactor still passes.

- house-planner engine smoke (outside the repository, `/tmp/nt-native-gpu-executor-1/hp`): the reactor lane's
  native `hp-engine.lib.a` linked with `libntgpu-executor.a`, fed that lane's recorded inputs (T_DEVICE, one-triangle
  scene bulk, camera) and the executor's real events in `engine/reactor.js`'s delivery order: 288 presents, 285 frames,
  no protocol `ERROR`, no abort, and a 640×400 capture showing the shaded triangle. Every frame's GI command buffer
  holds the Naga-rejected `gi.insert` pipeline, so those submissions are refused (190 `UNCAUGHT_ERROR`s, the engine
  reports them as `ENGINE_GPU_ERROR`); without the submission guard the first one aborted the process. With the
  Naga-fix wgpu-native: 209 presents, 206 frames, zero `ERROR`/`UNCAUGHT_ERROR`, the engine stops requesting frames
  once settled, and the capture shows the GI-lit triangle.

## Not done / not claimed

No timings, memory or power numbers (machine shared with other agents). No on-screen composition (the surface test
uses a window-less layer). No platform other than macOS arm64. The house-planner run above is a smoke run of the
reactor lane's artifacts, not an image-equality check (the house-planner goldens and Bresso scene were not used).
