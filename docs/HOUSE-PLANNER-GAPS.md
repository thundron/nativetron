# House-planner integration gaps

Inspected scriptc `internal` at `76dc1100ef9a45ad91ca52760534c611d13eb1d3`. No scriptc files or refs were changed. The house-planner checkout was read only; benchmark code is a local adaptation, not a runtime dependency.

## SIMD128

The current public wasm build path does not expose `-msimd128` or a wasm SIMD feature option. The target in `packages/compiler/src/backend/targets.ts` is wasm32, generic CPU, empty features. `native/llvm-codegen/src/target.cpp` constructs its target machine with `generic` and an empty feature string; `backend/native-codegen.ts` passes the triple and optimization level, not a wasm feature list. `--target-cpu` is restricted to x86-64 levels and rejects non-x86 targets in `backend/target-cpu.ts`. The release optimizer in `backend/wasm-opt.ts` also lists enabled nontrapping-conversion/bulk-memory/sign-extension/mutable-global features, not SIMD; its validation/feature posture must be extended consistently.

LLVM/Zig can generate wasm SIMD, so this is a compiler/toolchain-plumbing gap, not a WebGPU or TypeScript-language prohibition. Merely appending `-msimd128` to the final link would not recompile the already emitted program object, nor guarantee useful vectorization. A supported feature flag must reach LLVM emission, helper identity/protocol and cache keys, and participate in binary feature/compatibility tests. Scalar runtime objects can coexist with SIMD program code; SIMD runtime variants would need their own pack metadata and validation if pursued.

Estimate: 2–4 engineering days for a guarded opt-in feature and end-to-end emission/compatibility tests, assuming no runtime-pack redesign; another 1–2 weeks to investigate useful vectorization of actual geometry loops, bounds/alias checks and any explicit vector API. These are planning estimates, not measured implementation effort. No SIMD speedup is claimed by the benchmark below.

## Wasm threads and shared memory

The produced reactor exports ordinary, unshared linear memory. `bench/engine-bvh/inspect.mjs` instantiates the real module and checks that its buffer is not a SharedArrayBuffer. The current generated glue instantiates each reactor independently, stages entry arguments into that instance's allocator, and defines no imported shared memory or thread-start protocol. The current library restrictions on promises/async/timers do not themselves prohibit multiple host Workers, but Workers are not equivalent to sharing one reactor heap.

scriptc has native shared-storage/Atomics machinery (`runtime/src/scr_shared.c`) and native worker support; that does not establish a browser wasm-threads ABI. The runtime's threaded waits use the native worker/thread-instance configuration. A browser implementation still needs atomics/bulk-memory target features, a bounded shared-memory linker contract, worker bootstrap and independent stacks/TLS, allocator synchronization, runtime/global initialization rules, ownership/collection safety, and panic/teardown semantics. Reinstantiating the current module against one shared memory would not make its globals, stacks and allocator safe.

Estimate: 4–8 engineering weeks for a constrained shared-bytes worker ABI with platform validation; arbitrary shared object graphs and concurrent collection may take longer. This should be designed separately from native `@scriptc/threads` publication, rather than assuming that API becomes a browser implementation unchanged.

For now, the nativetron engine can run in a dedicated Worker, and applications can use independent reactor instances with coarse binary messages. That is isolation/parallel task execution, not shared-heap wasm threading. COOP/COEP headers are available on the bundled WebKit/Android responses and browser test server; Windows virtual-host header injection is not implemented. Headers alone do not prove crossOriginIsolated or SharedArrayBuffer support for custom webview origins. Each target must be tested before enabling a shared-memory lane.

## f32 arithmetic

Float32Array storage is 32-bit; JavaScript `number` arithmetic remains f64. In `backend/llvm/expr-bytes.ts` and `byte-numbers.ts`, float loads widen to double and stores truncate to float. `Math.fround` in `backend/llvm/lib-filesystem.ts` explicitly emits `fptrunc double ... to float` followed by `fpext float ... to double`.

The emitted `f32Probe` in the benchmark confirms this sequence:

```llvm
load float
fpext float ... to double
fmul double
fadd double
fptrunc double ... to float
fpext float ... to double
```

Thus Float32Array expressions do not automatically become f32 arithmetic, and Math.fround rounds an expression's result rather than changing all preceding operators to f32. LLVM may optimize particular expressions when equivalence is provable; there is no promise of an f32 instruction lane. This preserves JavaScript numeric semantics. An explicit f32 IR/type or intrinsic surface would need a separate design and numerical tests; silently enabling fast-math or changing Number semantics is not proposed.

## Binned SAH and refit measurement

Source: `bench/engine-bvh/algorithm.ts`, adapted from house-planner's `packages/render/src/gi/binned.ts` without importing that repository. Both V8 and wasm execute the same local source. The adaptation uses Float32Array bounds/centroids/bin bounds and Uint32Array primitive order; original house-planner binary-builder bounds use Float64Array. This measures the requested Float32/Uint32 lane, not an unchanged production WBVH build.

50,000 deterministic triangles; 16 bins; three-axis binned SAH; one primitive per leaf; 99,999 nodes. Refit recomputes leaf AABBs from nine Float32 vertex coordinates and unions internal children bottom-up. Input generation/instantiation and validation are outside timed windows; build includes its normal allocation/partitioning costs. Five warmups, then 21 paired/interleaved trials, reversing V8/wasm order each trial. Both lanes run in the same official Node process/V8 runtime.

Apple M4 Max, macOS arm64, official Node 24.22.1, V8 13.6.233.17-node.58, ICU 78.3:

| workload | V8 median | wasm median | wasm / V8 | V8 p95 | wasm p95 |
|---|---:|---:|---:|---:|---:|
| 50k-triangle binned SAH build | 85.12 ms | 99.56 ms | 1.17× | 88.52 ms | 101.31 ms |
| 99,999-node AABB refit | 1.13 ms | 1.48 ms | 1.31× | 3.57 ms | 1.56 ms |

Wasm is slower at the median in both workloads. The V8 build had a 220.64 ms outlier; all raw samples are retained in `bench/engine-bvh/last-run.json`. This is not evidence that an AOT wasm engine is faster than V8, nor an estimate of complete house-planner frame time.

Every trial checks node count, parent/child containment, leaf bounds against triangle vertices, one occurrence of every primitive, and a full topology/bounds/order checksum (`3659461890`) across implementations, before and after refit. An additional deformed-triangle refit checks that the result changes and still matches V8. The timed refit inputs are the unchanged deterministic mesh. The module is 100,297 bytes; final linear memory is 36,175,872 bytes, including runtime/stack capacity, not RSS.

Reproduce under the official Node distribution:

```sh
PATH=/tmp/node-v24.22.1-darwin-arm64/bin:$PATH bench/engine-bvh/build.sh
/tmp/node-v24.22.1-darwin-arm64/bin/node bench/engine-bvh/run.mjs
/tmp/node-v24.22.1-darwin-arm64/bin/node bench/engine-bvh/inspect.mjs
```

The absolute Node path is the installation used here; substitute another official Node 24.22.1 installation, not a Homebrew build with different ICU. The harness refuses the wrong Node/ICU pairing. Browser/V8, Windows/Android/iOS CPU results, SIMD variants and multiworker speedups were not measured.

## Framework/platform delivery and remaining scope

- P1: generated WebGPU command surface, async request ids/events, generational resource handles, direct linear-memory uploads, readback, resize/DPR notifications and one-shot frame scheduling. Real Chrome acceptance includes compute-generated vertices/indirect draw, checked readback, presented pixels, 16 MiB upload, memory growth during frame encoding, shader line numbers, device loss and idle checks. See `gpu/README.md` for the exact API and measured transport cost.
- P2: separate in-page engine reactor and independently compiled UI, preferred Worker/OffscreenCanvas lane with detected main fallback, generated bounded binary control IPC, offline custom-scheme assets, and a native-menu colour-change test. Chrome worker/main and WKWebView on macOS 27.0.1 pass; macOS 26 is not available here.
- P3: iOS simulator build/launch reports no WebGPU correctly on iOS 18.6. Android APK and Windows PE cross-build. There is no connected Android device or available physical iOS 26 device, and no Windows runtime; those GPU paths remain untested. See `hosts/README.md` for build evidence and limitations.
- P4: English-first generated cardinal messages, real host Intl number/unit formatting through an installed bounded callback, command registry/palette, fixed-row virtual lists/tables and a generated scroll event. Compiled Chrome integration passes. Other locale rules, native formatter adapters, focus trapping, variable-height virtualization, split panes and docking are not implemented.

The GPU surface is deliberately not a complete WebGPU binding: current render passes/pipelines expose one colour target and optional depth/resolve; blend choices are none or standard source-alpha; mapping is readback or mapped-at-creation upload/unmap. Multiple colour targets, stencil state, arbitrary blends, texture-to-buffer copies and additional device features need schema extensions and tests. Resource creation errors fail explicitly; no renderer is substituted when WebGPU is absent.

Open questions: which additional render targets/features/formats does the first engine milestone require; should unavailable WebGPU disable 3D editing or offer a separately scoped fallback; which physical iOS/Android and Windows machines should form the acceptance matrix; and should SIMD work begin with compiler flag plumbing or with profiling the scalar BVH loops? scriptc integration-history changes (including the requested rebase preference) remain separate and were not performed under this read-only brief.
