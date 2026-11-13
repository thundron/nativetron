# Native GPU feasibility result

## Decision

Keep native GPU execution experimental and opt-in. Do not make it the default macOS path. The same guest protocol works through the native executor, but the measured application path is slower than Chrome, public-API DOM composition is incomplete, and the controlled Low Power Mode acceptance gate has not been measured. This is a completed implementation and AC feasibility investigation, not production-feature acceptance.

The default remains the existing JS WebGPU host. No Dawn runtime was added. Tint was built only as an external, offline shader-validation tool. Experimental native rendering uses pinned wgpu-native with two documented, generic Naga fixes; house-planner needs no source or shader edits.

See [measurements and exclusions](benchmark/RESULTS.md) for raw-data locations, reproduction commands and the full per-run validity rules. Other users' GPU workloads were observed; affected runs were excluded, not silently called uncontended.

## What runs end to end

- The generated C++ decoder and real native executor implement all 64 executable operations plus the protocol header, preserving protocol 3, the guest API and the 20-bit slot/12-bit generation scheme.
- A Wasm reactor in the actual macOS WKWebView Worker sends owned, bounded binary chunks through WKURLSchemeHandler. Readbacks and events return through the same authenticated, generation-scoped channel without base64 GPU traffic or a loopback server.
- A native scriptc reactor runs through the same executor in-process or in an isolated child process. Native and Wasm reactors produce matching Bresso captures within the application's tolerance.
- The engine's golden, still, panorama and video-frame flows execute real GPU work. Video-frame support does not imply native video-container encoding; browser WebCodecs is outside this executor.
- Host fences return frame credits only after the GPU completes all of a frame's submissions. CPU-consumption acknowledgements separately release transport copies. No guest export is called reentrantly.

## Evidence

| Check | Result |
| --- | --- |
| Generated native decoder vs JS decoder | 7,056 shared valid/malformed wire fixtures match |
| Native conformance reactor | Real Metal execution passes the browser conformance assertions |
| Native shader frontend | 199 real modules and 845 distinct pipeline descriptors pass with the two Naga patches |
| Offline Tint at Chrome 154's exact revision | Real corpus translates without rejections/warnings to MSL, SPIR-V and HLSL; generated MSL compiles with Metal |
| Final native/Wasm Bresso golden replay | Bit-identical engine captures; both within the committed living-view golden tolerance |
| Still, panorama and video-frame replays | Within the application's 12/255, 0.5%-pixel tolerance against the captured Chrome baseline |
| Actual macOS Worker-to-native test | Real compute/render/readback, 16 MiB upload, restart and page reload pass |
| Frame-completion credits | Multi-flush, delayed-GPU, loss, cancellation, timeout and idle tests pass |

The corpus comes from one Bresso scene and covers the observed kernel shapes and constants, not every possible scene-dependent specialization. Pipeline replay is stronger than standalone translation but is not a claim of full WebGPU CTS conformance. Native rendering on other operating systems has not been tested.

The original wgpu-native build rejects valid consumer shaders in two cases. The generic fixes implement WGSL behavior analysis for function termination and preserve runtime semantics of let-bound override expressions. Neither fix rewrites consumer source. See [compiler fixes](compiler/README.md).

## Measured result

All rows below are accepted AC/High Power samples with Low Power Mode off and nominal thermal state, on this Apple M4 Max/macOS 27.0.1. The application canvas was 1600×1520 with fixed desktop tier and deterministic GI. Values are medians of the accepted runs, not display FPS; each measured work frame waits for GPU completion.

| Path | Still ms/frame | Moving ms/frame | Accepted runs |
| --- | --- | --- | --- |
| Visible Chrome, JS WebGPU | 3.92 | 15.23 | 7/13 |
| WK Worker → native, without presentation | 8.10 | 21.20 | 7/14 |
| WK Worker → native, overlay presentation | 8.40 | 21.70 | 3/15 |
| CLI native reactor → native executor | 6.13 | 21.32 | 6/12 |
| CLI Wasm reactor → native executor | 6.16 | 21.45 | 5/12 |

The CLI rows isolate reactor execution and must not be presented as the actual WK application path. They do not demonstrate a whole-application native-compilation speedup. The captured GPU timestamps also show slower GPU work through this native backend; transport is not the only cost.

Warm-cache first image was 553 ms native versus 522 ms Chrome. A native run with its own Metal cache moved aside took 6,274 ms; Chrome's shared OS cache was not cleared, so this is not a comparable cold-cache race. Original native cache contents were restored.

Tracked engine allocations were 346 MB on each path. Summed process physical footprint was 713 MB native versus 863 MB Chrome; that is not an independently measured physical GPU-residency figure. Idle samples recorded zero engine frames after settlement. The linked host binary grew from 0.93 MB to 12.69 MB in the measured builds; packaging and stripping policy are not finalized.

Moving native frames crossed about 10.9 KB upstream plus 1.36 KB of readback, with about 0.73 ms per submit. These are observable application/wire counters. WebKit's and Chrome's internal copies were not observable and are not counted as zero.

## Low Power Mode gate

The controlled comparison is blocked by administrator permission. The noninteractive pmset change attempts requested a password and were not retried interactively. AC remained at powermode 2 and battery at powermode 1; the saved settings before and after the measurement session match.

One clean Chrome-only sample happened while the owner unplugged the charger and the OS entered Low Power Mode. It is reported separately in the measurement report and cannot substitute for a paired native comparison. Native Low Power Mode performance is therefore unknown, and the binding acceptance gate is not passed. To complete it, the owner must enable Low Power Mode for the paired run or grant temporary noninteractive permission for the power-setting command, with restoration afterward.

## Composition and failure recovery

On the tested macOS WebKit, underPageBackgroundColor does not make WKWebView transparent. Public overlay composition hides translucent DOM over the scene, and some overlay runs stalled when the surface was reported invisible. The experimental underlay-spi flag uses the private drawsBackground setting and is explicitly a shipping policy blocker, not a supported public solution. Colour-space/EDR parity is not established.

The pinned C API has aborting or incomplete entry points. The facade avoids known unsafe calls, and the executor catches tested guest-triggered submit failures before entering the aborting path. Driver/internal failures can still terminate the process. Production recovery must isolate the executor as well as the reactor, or carry a standards-correct backend error-handling fix.

A trapped native reactor is permanently poisoned. C guards refuse subsequent calls without unwinding through Swift/Objective-C; a new isolated process is the reclaimable restart strategy. Repeated dlopen/thread replacement without reclaiming runtime state is not an acceptable production restart policy.

## Compiler integration

The scriptc branch spike/native-gpu-upstream-83f37d2af6 merges upstream 83f37d2af6 into the fork and ends at fae39fa2dc (scriptc 0.4.12). Runtime ABI v50 prevents new compiler output from silently linking old v49 packs. Scriptc main remains at 38dacef1f8. Nothing was pushed.

The merged branch passed focused compiler/library/ABI, native/WASI differential, order-parity and sanitizer checks; no new full-suite claim is made. The engine's 12,570 statements compile statically. Parent validation also ran the consumer's actual Chrome parity procedure with the new Wasm library: V8 vs Wasm and Wasm vs repeat are bit-identical for aerial, living, kitchen and bathroom views. The merged compiler's native and Wasm Bresso golden captures through the native executor are bit-identical. Match compiler and runtime-pack ABI when reproducing these results.

## Full-feature work and acceptance

| Target | Work required before a supported release |
| --- | --- |
| macOS arm64 | Close the measured GPU-time gap; choose a public, correct composition architecture; fix invisible-surface stalls; isolate fatal backend failures; implement bounded restart-based fallback; pass the paired Low Power gate |
| macOS x64 | Build and link matching Intel artifacts, validate deployment targets and GPU-family limits, then repeat conformance, captures, composition and power tests on real hardware |
| iOS arm64/simulator | Add the UIKit surface host and binary channel; validate public transparency, background/foreground and memory pressure; build/link native Metal on simulator and device separately. Missing browser WebGPU in a simulator does not establish whether native Metal works |
| Android arm64 | Add a Vulkan surface/activity integration, negotiate device limits honestly, implement bounded binary transport and lifecycle recovery, and validate on physical devices. Native GPU alone does not remove browser Wasm thread-isolation requirements |
| Windows x64 | Add DX12 surface/window integration and the binary channel, package matched native artifacts, handle DPI/device removal, and validate real adapters and fallback |
| Browser | Keep the existing JS host; no native dependency or host-only privilege |

CI must pin matching headers/libraries/patches and their provenance, regenerate the decoder from ops.json, run shared malformed-stream fixtures and exactly-once lifecycle tests, and use real GPU runners for conformance and image tolerances. Cross-compiling or an emulator boot is not GPU acceptance. Generate complete transitive Rust notices/SBOM before distribution. Per-target binary impacts and rebuild times still require target builds; the macOS figures must not be extrapolated.

Select the executor before creating resources. A future native-preferred mode must renegotiate capabilities and restart/replay reactor state after backend changes, never migrate live handles between native and JS devices. On this OS, WebKit's shader failure means JS fallback may itself be unusable; report that explicitly. Current experimental opt-in does not implement automatic runtime fallback.

## Reproduction and retained artifacts

Use [executor instructions](EXECUTOR.md), [reactor instructions](reactor/README.md), [app integration](../../hosts/macos/NATIVE-GPU-APP.md) and [benchmark instructions](benchmark/README.md). The final proof logs and binaries are under /tmp/nt-native-gpu-final; the complete final image replay with the merged compiler is under /tmp/nt-reactor-e2e/runs/final-all-merged. Parent validation passed 106 Node checks, native conformance and the final linked macOS host-service and GPU self-tests. Raw measurements, exclusions, provenance and the measured app are under /tmp/nt-native-gpu-measurements-root. The relocatable merged-branch compiler, matching packs and consumer proof are under /tmp/nt-native-gpu-scriptc-proof. These are reproducibility artifacts, not a formal audit or a production qualification.
