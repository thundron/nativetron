# Native WebGPU backend (wgpu-native) — bootstrap, facade and shader probe

This directory is the native-GPU backend lane of the native GPU spike: a pinned wgpu-native dependency, a small C ABI
facade (`ntgpu.h`) that owns the instance/adapter/device lifecycle, error scopes, WGSL diagnostics and asynchronous
completions, and a probe CLI (`ntgpu-probe`) that reports real capabilities, validates WGSL files and runs GPU
correctness proofs. It does **not** contain the protocol decoder: the decoder generated from `gpu/ops.json` takes the
raw `webgpu.h` handles from the facade and issues every other WebGPU call itself. The JS host, `ops.json`, the guest
API and `gpu/generate.mjs` are untouched. No Dawn.

## Dependency

| | |
|---|---|
| implementation | wgpu-native **v29.0.1.1**, commit `6aed50955d934ac36049ba8d002034841633ae02` (wgpu-core / naga 29.0.1) |
| artefact | `wgpu-macos-aarch64-release.zip`, 13,733,288 B, sha256 `a5797a37b1adf720bcd5dcffb291edbbd5b7b14be0a3874c28e6393a655a7a3e` (equal to the GitHub release asset digest) |
| headers | `webgpu.h` = webgpu-native/webgpu-headers@`673658bc2bd70ec39fc55ebe6bb0173cf6d0a603` (the `ffi/webgpu-headers` submodule of the commit); `wgpu.h` = `ffi/wgpu.h` at the commit. Byte-compared against upstream by `fetch-deps.sh`. |
| licences | wgpu-native MIT OR Apache-2.0; webgpu-headers BSD-3-Clause. The static library also bundles ~140 Rust crates (`provenance/Cargo.lock`); a third-party notice file for them is **not** generated yet. |
| cache | `$NT_NATIVE_GPU_DEPS` (default `/tmp/nt-native-gpu-deps`, outside every worktree): `downloads/v29.0.1.1-wgpu-macos-aarch64-release.zip`, `wgpu-native/v29.0.1.1/macos-aarch64-release/{include,lib,wgpu-native-meta,provenance}` |

`wgpu-native.lock` holds every digest (archive, both headers, `webgpu.yml`, both libraries, licences, `Cargo.lock`,
the release's `commit-sha` asset) plus the release digests of the macOS x64, iOS, iOS-simulator, Android arm64 and
Windows x64 archives (recorded, not downloaded). `fetch-deps.sh` downloads once, verifies everything, stages and
renames atomically; later runs (and `--offline`) re-verify the cached files and print the prefix. Nothing is installed
globally.

## Build and test

```sh
gpu/native/fetch-deps.sh                  # download + verify (or verify the cache) → prints the prefix
gpu/native/build.sh                       # static link (default) → /tmp/nt-native-gpu-deps/build/macos-arm64-static/
gpu/native/build.sh --link dynamic        # → …/macos-arm64-dynamic/ (absolute LC_RPATH into the cache; dev only)
gpu/native/build.sh --sanitize address    # ASan+UBSan; --sanitize thread for TSan
node gpu/native/probe.test.mjs            # builds, then checks everything below on the real adapter
NTGPU_LINK=dynamic node gpu/native/probe.test.mjs
```

Build outputs never land in the worktree (`$NTGPU_BUILD_DIR` overrides the directory). Compile line: `clang++
-std=c++17 -O2 -Wall -Wextra -Werror -target arm64-apple-macos14.0 -I<prefix>/include -Igpu/native`. Link line
(static): `libntgpu.a <prefix>/lib/libwgpu_native.a -framework Metal -framework QuartzCore -framework Foundation
-framework CoreFoundation -lobjc -liconv -Wl,-dead_strip`, then `strip -x`. Swift imports the facade through
`module.modulemap` (`swiftc -I gpu/native -I <prefix>/include …`); `swift-smoke.swift` is built and run by the test.

Linking/loading: **static** is what an app host would ship (single executable, no rpath, no loader work).
**Dynamic** links `@rpath/libwgpu_native.dylib`; a bundle would copy the dylib into `Contents/Frameworks` with an
`@executable_path/../Frameworks` rpath. Runtime `dlopen` with a proc table is not implemented (wgpu-native's
`wgpuGetProcAddress` is unimplemented and aborts, so a loader would have to `dlsym` every symbol).

Sizes measured on this Mac (macOS 27.0.1, Apple M4 Max, Xcode clang 21): `ntgpu-probe` static and stripped
6,068,824 B, i.e. wgpu-native's dead-stripped contribution is ≈5.9 MB; `ntgpu-probe` dynamic 166,376 B +
`libwgpu_native.dylib` 6,933,424 B; `libwgpu_native.a` 34,356,312 B on disk; `libntgpu.a` 46,776 B. No build-time
number for wgpu-native is given because nothing is compiled from Rust (prebuilt).

## Verified vs speculative

Verified here, macOS arm64 only, Metal backend, real adapter "Apple M4 Max": every check in `probe.test.mjs`, with
both link modes, and `lifecycle`/`proof`/`surface` additionally under ASan+UBSan and TSan with no reports.
Speculative (not built, not run): macOS x86_64, iOS device and simulator, Android, Windows. Release archives with
recorded digests exist for each, and the facade has no macOS-only code apart from `probe-surface-darwin.mm` and the
`backendType = Metal` adapter preference under `__APPLE__`; nothing beyond that is claimed.

## Probe CLI

`ntgpu-probe <command> [options]` writes one JSON document to stdout. Exit 0 = pass, 1 = a checked stage failed,
2 = usage/environment error. Nothing is timed; GPU work is correctness-only.

| command | what it does |
|---|---|
| `caps` | adapter info, adapter and device features (standard WebGPU names; implementation-specific ones as `native:<name>`), all 32 limits for adapter and device (`null` = left undefined by the implementation) |
| `shader FILE.wgsl…` | **stage 1 shader module**: WGSL parse + Naga validation via error scopes, with synthesized `location {lineNum, linePos, offset, length}` (UTF-16, like `GPUCompilationMessage`) and a one-line `summary`; **stage 2 pipelines**: compute pipelines (layout `auto`) for `--entry NAME` (repeatable; default every `@compute` entry found by a lexical scan) and one render pipeline for `--render VS[,FS]` with `--target FORMAT`…, `--depth FORMAT`, `--vbuf STRIDE[/instance]:LOC=FORMAT@OFFSET[,…]`… (slot order), `--topology NAME`; `--constant NAME=VALUE` for overrides; `--module-only` stops after stage 1. Entries with no pipeline are listed under `moduleOnly` (they passed module validation only). |
| `proof` | compute: 4096 invocations run an `atomicCompareExchangeWeak` increment loop on one counter and claim 64 slots by CAS 0→id+1; checks counter = 4096, exactly 64 winners, every slot claimed by an id ≡ slot mod 64 whose winner flag is set, every flag written (sentinel pre-fill). Render: full-screen triangle into a 4×4 `rgba8unorm` texture, copy to buffer, checks every pixel = (64,128,191,255). Both read back through `ntgpu_map_async` → MAP event → `getConstMappedRange`. |
| `lifecycle` | idle `ntgpu_process` returns without polling; empty-stack pop refused; emulated Internal scope; validation scope capture; 7 uncaptured errors into a capacity-4 queue → 4 events + OVERFLOW(3) and exactly one wake; work-done event; `ntgpu_device_destroy` emits DEVICE_LOST(Destroyed) once (second destroy silent); compile/work-done after loss refused with `device-lost`; a missing feature and an excess limit are refused with a DEVICE error event; re-request yields generation 2 and works; a waiter thread blocking in `ntgpu_process(ctx,1)` completes a readback while the driver waits on the wake hook; teardown with a map still outstanding. |
| `surface` | `CAMetalLayer` (not in a window) → surface → capabilities → configure (first supported format, FIFO, auto alpha) → 3× acquire, clear pass, present. Proves the API path only, not composition under a WKWebView, pacing or occlusion. |

Common options: `--power low|high`, `--feature NAME` (repeatable), `--all-features`, `--adapter-limits` (request the
adapter's limits instead of the WebGPU defaults).

Executed evidence (this Mac, 2026-11-13): `caps` → backend metal, device "Apple M4 Max"; default device limits
(e.g. `maxStorageBuffersPerShaderStage` 8, `maxBufferSize` 268435456) and adapter limits (31, 86586540032).
`proof` → casCounter 4096, claimedSlots 64, winnerFlags 64, badSlots 0, unwrittenWinners 0; pixel 64,128,191,255,
0 mismatched channels. `lifecycle` → all 22 checks pass. `surface` → bgra8unorm-srgb, 3/3 success-optimal acquires,
3/3 presents. Fixtures: `atomics-cas` both pipelines ok; `bad-syntax` module error at 6:1 "expected `;`";
`bad-type` 5:3 length 11; `unicode-error` (emoji + `é` before the error) 4:22 with UTF-16 offset consistent with the
line/column; `workgroup-too-large` module ok, pipeline refused (1024×2 > 256); `override-required` pipeline refused
without `--constant scale=2`, ok with it; `render-attributes` ok with `float32x3`/`float32x2` buffers, pipeline refused
with `sint32x3`; unknown `--entry` refused at the pipeline stage.

## Facade (`ntgpu.h`)

C ABI over the standard `webgpu.h` only; `wgpu.h` extensions (`wgpuDevicePoll`, `wgpuGetVersion`) stay inside
`ntgpu.cc`, so guest semantics never depend on them. One thread drives a context; the event queue and the wake hook
are thread-safe, and `ntgpu_process` may run on one waiter thread while the driver keeps working, provided
device re-request/destroy and `ntgpu_context_destroy` are not concurrent with it (join the waiter first).

- **Lifecycle**: `ntgpu_context_create(options)` (bounded queue capacity, per-message byte limit, wake hook) →
  `ntgpu_request_adapter(token, power)` → `ntgpu_adapter_capabilities` → `ntgpu_request_device(token, features, n,
  limits|NULL)` → `ntgpu_device_capabilities`. Raw handles: `ntgpu_instance/adapter/device/queue` (borrowed, valid
  for the current device generation). `ntgpu_context_destroy` releases queue → device → adapter → instance; the
  device release waits for the GPU and completes outstanding callbacks, which are discarded.
- **Events** (`ntgpu_next_event`): ADAPTER, DEVICE, DEVICE_LOST, UNCAPTURED_ERROR, MAP, WORK_DONE, OVERFLOW, each with
  status, the `webgpu.h` detail enum, device generation, caller token and a message valid until the next call.
  Native callbacks only append to the queue; when it turns non-empty they call the wake hook, which must only post
  to the host's run loop. The reactor is never entered from a callback.
- **No idle polling**: `ntgpu_pending()` counts outstanding map/work-done operations; `ntgpu_process(ctx, wait)` returns
  immediately at zero. wgpu-native has no completion notification (no `wgpuInstanceWaitAny`), so while work is
  pending the host either blocks a waiter thread in `ntgpu_process(ctx, 1)` (sleeps in the Metal wait) or calls
  `ntgpu_process(ctx, 0)` once per presented frame.
- **Error scopes**: `ntgpu_scope_push/pop` are balanced and complete synchronously. Underflow returns
  `NTGPU_ERR_ARGUMENT` (wgpu-native would abort). `WGPUErrorFilter_Internal` is emulated (wgpu-native aborts on it and
  never raises internal errors), so it always pops clean.
- **Device loss**: `ntgpu_device_destroy` (and destruction by a re-request or teardown) emits DEVICE_LOST(Destroyed)
  once per generation — wgpu-native does not call the lost callback for `destroy()`. A real loss reported by the
  implementation goes through the same once-per-generation gate. After loss the helpers refuse with
  `NTGPU_ERR_DEVICE_LOST` without touching the device; `ntgpu_request_device` starts a new generation. The facade
  always installs lost and uncaptured-error callbacks (wgpu-native's defaults abort the process).
- **Shader/pipeline helpers**: `ntgpu_compile_wgsl` (module stage), `ntgpu_create_compute_pipeline`,
  `ntgpu_create_render_pipeline` (pipeline stage) wrap creation in validation + out-of-memory scopes and return
  `NtGpuDiag`. They release invalid objects; a decoder that needs WebGPU's invalid-object semantics should push the
  scopes itself around the raw call. `ntgpu_wgsl_location` turns a Naga report into
  `GPUCompilationMessage`-style fields.
- **Readbacks**: `ntgpu_map_async(buffer, mode, offset, size, token)` → MAP event → `wgpuBufferGetConstMappedRange` /
  `wgpuBufferGetMappedRange` → `wgpuBufferUnmap`. A refused map completes with an error MAP event and its validation
  error is captured, not reported as uncaptured.
- **Presentation**: `ntgpu_surface_from_metal_layer(layer)` (standard `WGPUSurfaceSourceMetalLayer`) and
  `ntgpu_surface_configure(surface, format|Undefined, w, h, presentMode, alphaMode, &chosen)`; acquire/present are
  plain `webgpu.h`. The host owns the `CAMetalLayer`, its size/DPR and display-link pacing.
- **Names**: `ntgpu_feature_name/ntgpu_feature_from_name` (WebGPU JS spellings, the same strings as `ops.json`),
  `ntgpu_limit_count/ntgpu_limit_at` (JS limit names; returns 2 for an undefined field), so the generated decoder can
  map protocol feature bits and limit ids by name.

### Notes for the protocol decoder

- `requestDevice`/`requestDeviceWith`: adapter request → adapter capabilities → decoder computes missing features
  and limits per the protocol rules → device request → device capabilities → CAPABILITIES. The facade refuses a
  required feature the adapter lacks (wgpu-native would silently ignore it and create the device).
- `createShaderModule` → SHADER_INFO: messages come from the error scope plus `ntgpu_wgsl_location`; there are never
  warnings and `type` is always `error` (no `getCompilationInfo`).
- `create*PipelineAsync`: wgpu-native does not implement the async variants (they abort). Create synchronously inside
  scopes and post the completion as the async result; the creation call blocks for Naga → MSL → Metal compile.
- Labels: pass them in descriptors only; every `wgpu*SetLabel` aborts.
- `maxBindGroupsPlusVertexBuffers` is left undefined by wgpu-native (adapter and device); report the WebGPU default.
- The surface's first format on Metal is `bgra8unorm-srgb`; browsers report `bgra8unorm` as the preferred canvas
  format, so the decoder should configure `bgra8unorm` explicitly to match the JS host.

## wgpu-native v29.0.1.1 gaps that matter

Calling any of these aborts the process (Rust `unimplemented!()`/`panic!` across `extern "C"`): `wgpuInstanceWaitAny`,
`wgpuShaderModuleGetCompilationInfo`, `wgpuDeviceCreateComputePipelineAsync`, `wgpuDeviceCreateRenderPipelineAsync`,
`wgpuDeviceGetAdapterInfo`, `wgpuDeviceGetLostFuture`, `wgpuBufferGetMapState`, `wgpuBufferReadMappedRange`,
`wgpuBufferWriteMappedRange`, `wgpuGetProcAddress`, `wgpuInstanceGetWGSLLanguageFeatures`,
`wgpuInstanceHasWGSLLanguageFeature`, `wgpuGetInstanceFeatures`, `wgpuHasInstanceFeature`, every `*SetLabel`,
`wgpuExternalTexture*`, `wgpuTextureGetTextureBindingViewDimension`; also `wgpuDevicePushErrorScope(Internal)`,
`wgpuDevicePopErrorScope` on an empty stack and the default uncaptured-error/device-lost handlers. Callbacks
(`requestAdapter`, `requestDevice`, `popErrorScope`) complete inside the call; map/work-done complete inside
`wgpuDevicePoll`/`wgpuInstanceProcessEvents`.

Capability differences seen on this Mac versus Chrome's WebGPU feature names: no `core-features-and-limits`,
`clip-distances`, `texture-formats-tier1/2` or standard `subgroups` (subgroups exist only as the native `subgroup`
feature, and Naga 29 rejects `enable subgroups;` with "not yet supported"). `shader-f16` works with `enable f16;`
when requested. `timestamp-query` is available.

## Missing

- The protocol decoder and its run against `gpu/verify.mjs`/the conformance reactor (another lane).
- House-planner shader fixtures (the shader lane supplies them; the CLI accepts them as they are).
- Presentation under a transparent WKWebView, display-link pacing, `frameMode`, resize/DPR and occlusion; the surface
  probe uses a window-less layer.
- Third-party notices for the statically linked Rust crates; runtime `dlopen` loading; any platform other than macOS
  arm64; any timing, memory or Low Power Mode measurement (deliberately none in this lane).
