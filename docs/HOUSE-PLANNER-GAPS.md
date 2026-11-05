# House-planner integration gaps

I inspected scriptc `internal` at `76dc1100ef9a45ad91ca52760534c611d13eb1d3` (0.4.8) and house-planner at `119c919` (study §7.6, `gi/binned.ts`, `rt/wbvh/`). Source and refs in both checkouts were read only and unchanged. Existing ignored scriptc mobile runtime-pack outputs were built for linking, as permitted by the brief. The benchmark code is a local copy, not a runtime dependency. Line references below are to that scriptc revision. The binary facts come from `bench/engine-bvh/inspect.mjs`, which uses a dependency-free opcode census, run on reactors built locally with `SCRIPTC=…/scriptc/packages/cli/dist/main.js`.

Every effort figure below is a planning range, not measured implementation effort. Nothing in this report claims a SIMD, threading or f32 speedup.

## SIMD128

**State.** The wasm32-wasi build path cannot request SIMD128:

- `packages/compiler/src/backend/targets.ts:189-190` types every `NativeTargetSpec` as `cpu: "generic"; features: ""`, as string literal types. `WASM32_WASI_TARGET` (`:469-474`) follows that shape. Adding a feature means a type change that affects every target, along with its cache identity.
- `native/llvm-codegen/src/target.cpp:153-154` constructs the LLVM target machine with CPU `"generic"` and an empty feature string. The native helper ships prebuilt (`@scriptc/llvm-<platform>`), so a features parameter means a helper protocol change and a rebuild of the helper on every host platform (CONTRIBUTING: CMake, Ninja, LLVM 22, Zig 0.16).
- `backend/target-cpu.ts:114-121` accepts `--target-cpu` levels for x86-64 only and refuses other targets. `scriptc build --lib` rejects `--target-cpu` and `--optimization` outright, because the profile pins the posture. Any SIMD switch for reactors therefore needs a profile field, not just a CLI flag.
- `backend/wasm-opt.ts:8-13` hands wasm-opt `-Oz` with nontrapping-float-to-int, bulk-memory, sign-ext and mutable-globals enabled. `index.ts:2572` runs it only for the `release` posture. A module containing SIMD would fail that validation unless `--enable-simd` is added. The `speed` posture skips wasm-opt.
- Emitted binaries, in both postures: 0 SIMD128 (0xFD) instructions. The same modules do contain other post-MVP features: 508/525 saturating truncations and 136 bulk-memory operations, from program and runtime objects together. SIMD128 is the feature that is absent. In the IR, typed-array element loads are `align 1` (`expr-bytes.ts:549`).
- scriptc's separate wasm *translator* (native programs loading `.wasm`) rejects modules that use SIMD or threads (`docs/content/limitations/webassembly-modules.mdx`). That is a different direction and does not affect reactor emission.

**What enabling would take.** The SIMD feature has to reach LLVM emission, and also the helper protocol, the build and cache identity, wasm-opt flags, runtime-pack selection (if the runtime is ever built with SIMD) and compatibility tests. Appending `-msimd128` to the final link would not recompile the already-emitted program object.

Enabling the feature would not by itself vectorise these loops. LLVM might autovectorise them only if it overcame several obstacles:

- Float32Array data widened to f64 arithmetic (below)
- alignment-1 loads
- data-dependent min/max branches
- the builder's indirect `order[i]` gathers

An explicit vector API would be a separate language-surface design with Node-parity semantics.

**Estimates.**

- 3–6 engineering days for a guarded opt-in reactor target feature: types, helper protocol and rebuilds, cache keys, wasm-opt flags, and validation/compatibility tests, assuming no runtime-pack redesign.
- Another 1–3 weeks to establish whether the real geometry loops vectorise usefully, including alias/bounds analysis.
- An explicit vector intrinsic surface is unestimated; it needs a design first.

## Wasm threads and shared memory

**State.**

- The reactor defines one memory: limits flags `0` (unshared), 266 initial pages, **no maximum** (wasm shared memories require a maximum). It exports the memory and imports none. The module imports only four WASI functions and `scriptc.panic`. It contains 0 atomic (0xFE) instructions. `inspect.mjs` asserts all of this.
- `backend/native-toolchain.ts:73-87` (`wasmReactorLinkArgs`) links with `-mexec-model=reactor -Wl,--no-entry` plus exports. There are no `--shared-memory`, `--import-memory` or `--max-memory` arguments and no thread-start protocol. The generated glue instantiates each reactor independently.
- `library/prepare.ts:827-856` refuses `abi.instance_per_thread` on wasm with "instantiate separate Wasm instances instead", and refuses `abi.localize_runtime`. The limitations pages say the same: `wasi-target.mdx:8` ("Native runtime localization and thread instances are unsupported") and `native-worker-threads.mdx:46` ("Workers are unsupported in WASI, compiled libraries…").
- Native executables do have shared-storage and Atomics machinery. `runtime/src/scr_shared.c` implements it, and SharedArrayBuffer views in worker programs use relaxed atomic accesses with inline `atomicrmw` Atomics (`expr-bytes.ts:278-283`, `:1262-1279`). `@scriptc/threads` `publish()` shares immutable graphs between native threads, but it refuses typed arrays (`threads.mdx:132`), so it would not share BVH buffers even natively.

**What enabling would take.** A browser threads ABI needs:

- atomics and bulk-memory target features, plus a bounded shared memory with a maximum
- imported memory, a worker bootstrap, and per-thread stacks and TLS
- allocator synchronisation
- rules for runtime and global initialisation
- safety for reference counting and the cycle collector across threads
- panic and teardown semantics
- glue for Worker instantiation

Reinstantiating today's module against one shared memory would not make its globals, stack or allocator safe.

**Estimates.**

- 4–8 engineering weeks for a constrained "shared bytes + per-worker instances" ABI with platform validation.
- Arbitrary shared object graphs or concurrent collection would take longer.
- This should be designed separately from native `@scriptc/threads`.

What works today: the engine can run in one dedicated Worker, and an application can run independent reactor instances that exchange coarse binary messages. That is isolation and task parallelism, not shared-heap threading. Response headers needed for cross-origin isolation are platform work owned by the host streams. Headers alone do not prove `crossOriginIsolated` or SharedArrayBuffer support on custom webview origins; each target must be tested before a shared-memory lane is enabled.

## f32 arithmetic

**State.** Float32Array storage is 32-bit, but `number` arithmetic stays f64:

- Loads widen (`expr-bytes.ts:549-550`: `load float` then `fpext`), and stores narrow (`byte-numbers.ts:194`).
- `Math.fround` emits `fptrunc double → float` followed by `fpext` (`lib-filesystem.ts:1333-1339`).
- Emitted IR of the Float32 `buildBinary`: 160 `load float`, each followed by `fpext`; 53 `fptrunc` stores; **0** float arithmetic; 257 double arithmetic instructions; 0 vector types.
- The whole release binary contains 16 f32 comparisons and 1 f32 numeric instruction. LLVM narrows a comparison of two widened f32 values exactly. Everything else is f64.

**Observed narrowing (an LLVM optimisation, not a scriptc guarantee).** `bench/engine-bvh/f32-probe.ts` compiles one expression two ways. The form `c[i] = a[i] * b[i] + a[i]` (rounded once at the store) emits 0 f32 arithmetic. The form `Math.fround(Math.fround(a[i] * b[i]) + a[i])` emits f32 arithmetic at -O2 (3 `f32.add` and 1 `f32.mul` in the binary, which LLVM unrolled). Both return the same results as V8. Rounding after each `+ − × ÷` on f32 operands is exactly IEEE single-precision arithmetic, so the narrowing is legal. Today, though, it depends on LLVM InstCombine rather than on a compiler contract.

FFI's `f32` class (`ffi_format` 6) only rounds values at the native boundary; it is not a compute type.

**Numerical consequence (deterministic, measured by the smoke run).** The renderer-facing Float32 builder is not topology-identical to the original Float64 builder. At 4,096 and 50,000 triangles, its topology differs in 6 of 7 distributions; only `coincident-centroids` matches. The SAH ratio (Σ node half-areas / root) differs from the original by at most 0.03 %, and the maximum depths are equal. Switching precision is therefore a behaviour change that needs renderer-level tests, not a free storage optimisation.

**Estimates.**

- 1–2 weeks to make per-operation f32 a documented and tested contract (for example, a recognised `Math.fround(a op b)` pattern with corpus and IR tests).
- 3–5 weeks for an explicit f32 type or intrinsic surface with Node-parity semantics.
- Silently enabling fast-math or changing `number` semantics is not proposed.

## Binned SAH and refit harness

`bench/engine-bvh/` (see its README) now runs:

- **Two variants:** the verbatim original-precision Float64 `binned.ts` (provenance hash-checked) and the mechanical Float32/Uint32 substitution.
- **Seven deterministic distributions:** architectural, uniform soup, coincident centroids, geometric clusters, long slivers, far-offset mm parts and planar duplicates.
- **Three lanes:** V8, the scriptc `release` posture (-O2, wasm-opt -Oz) and the `speed` posture (-O2, size-for-speed runtime, no wasm-opt). All three execute the same source in one official Node 24.22.1 process.
- **Four timed windows:** allocation-only probe, bounds, build including allocation, and refit of changed geometry.

Every trial is paired and lane-rotated, and all raw and warmup samples are retained. Each trial is gated by in-module validation in every lane, exact cross-lane bit hashes and an independent JS validator. A corruption self-test shows that both validators reject bad trees.

Smoke evidence: the default smoke run (sizes 1–4,096) and a 50,000-triangle smoke run pass every gate in every lane. Smoke mode prints no timings and writes nothing.

**Final recording:** 2026-11-04T23:08:57.812Z, Apple M4 Max (16 logical CPUs), official Node v24.22.1/ICU 78.3; 4,096 and 50,000 triangles, 16 bins, 28 cases, 21 paired trials plus 5 warmups. Every validation/provenance/hash/deformation gate passed in every lane. All raw/warmup values, per-trial lane orders, p95/min/max and paired ratio ranges are in `bench/engine-bvh/last-run.json`. There were no modifying agents, builds, browsers from other tests, simulators or emulators running during recording; ordinary OS activity is not controlled. Load-average history is retained (6.90/5.41/4.90 before, 3.04/4.52/4.61 after), not hidden.

50k medians (milliseconds; ratios are per-trial wasm/V8 medians, **lower is better**, not ratios of the displayed medians):

| distribution | storage | build ms V8 / release / speed | paired build ratio release / speed | changed refit ms V8 / release / speed |
|---|---|---|---|---|
| architectural | f64 | 39.92 / 51.49 / 50.37 | 1.29 / 1.26 | 0.82 / 0.87 / 0.80 |
| architectural | f32 | 41.22 / 54.32 / 50.78 | 1.32 / 1.24 | 0.74 / 0.86 / 0.82 |
| uniform-soup | f64 | 60.36 / 78.24 / 78.53 | 1.30 / 1.31 | 0.77 / 0.90 / 0.87 |
| uniform-soup | f32 | 60.44 / 80.63 / 79.01 | 1.33 / 1.30 | 0.74 / 0.92 / 0.89 |
| coincident-centroids | f64 | 4.60 / 8.92 / 9.44 | 1.95 / 2.07 | 0.54 / 0.69 / 0.65 |
| coincident-centroids | f32 | 4.83 / 10.64 / 9.53 | 2.19 / 1.98 | 0.53 / 0.68 / 0.65 |
| geometric-clusters | f64 | 71.15 / 87.46 / 87.14 | 1.23 / 1.23 | 0.73 / 0.88 / 0.87 |
| geometric-clusters | f32 | 72.31 / 90.93 / 86.55 | 1.26 / 1.21 | 0.70 / 0.91 / 0.88 |
| long-slivers | f64 | 64.90 / 82.86 / 82.98 | 1.28 / 1.29 | 0.87 / 1.00 / 0.97 |
| long-slivers | f32 | 66.33 / 86.32 / 83.75 | 1.30 / 1.25 | 0.86 / 1.04 / 0.99 |
| far-offset-mm | f64 | 35.20 / 45.28 / 43.80 | 1.28 / 1.25 | 0.66 / 0.75 / 0.69 |
| far-offset-mm | f32 | 35.27 / 47.79 / 44.09 | 1.35 / 1.25 | 0.62 / 0.76 / 0.73 |
| planar-duplicates | f64 | 18.92 / 25.62 / 24.45 | 1.35 / 1.29 | 0.62 / 0.77 / 0.70 |
| planar-duplicates | f32 | 19.69 / 27.32 / 24.53 | 1.39 / 1.26 | 0.61 / 0.76 / 0.71 |

Neither posture beats V8 consistently; speed is not uniformly faster than release. Float32 storage does not establish a Float32 arithmetic or SIMD speedup. The two variants can choose different valid trees; exact hashes are compared **within** a variant across lanes, with cross-variant quality/topology differences recorded separately. Release/speed modules are release 324,742 bytes / speed 380,093 bytes and each ends at 103.56 MiB linear memory after the complete matrix. SIMD/shared memory are not enabled. The old single-variant, single-distribution, unchanged-refit results are superseded and no longer presented as current evidence.

Scope limits:

- The CWBVH collapse, quantisation and triangle repack are not copied.
- house-planner's Bresso fixture is not used: no house-planner data is imported. S1's "36 ms build, 2.5 ms refit, 20 ms extraction" is therefore not reproduced here.
- Browser, Windows, Android and iOS CPU results are not measured.

## Framework/platform delivery and remaining scope

All P1–P5 implementation/investigation streams are integrated. [The execution ledger](HOUSE-PLANNER-EXECUTION.md) and [serialized acceptance](HOUSE-PLANNER-ACCEPTANCE.json) are the authoritative evidence: **43 passed checks, zero failed, six explicit blocked gates**.

- P1: generated GPU protocol 3, common full render/compute descriptors, negotiation, terminal request ownership, safe handles, read-only callback buffers, guest-owned readback delivery and demand-driven frames; real Chrome main/worker conformance. See the GPU README for deliberately unsupported WebGPU API areas.
- P2: independently compiled UI/engine reactors in the page, Worker/OffscreenCanvas preference and main fallback, bounded full-envelope routing, preflight/cancellation/restart/shutdown, no synchronous reentry, offline generated asset policies. Chrome lifecycle and macOS 27 WKWebView/native-menu execution pass.
- P3: actual iOS/Android static control archives and complete host/build/acceptance paths; Windows virtual HTTPS response/isolation/offline/lifecycle host and runtime runner. Simulator/emulator assets/control/lifecycle pass, but neither supplies WebGPU. Cross-builds are not GPU runtime evidence.
- P4: three reactive catalogues, bounded plural/formatting hooks and static key checks; command/palette keyboard/shortcut/focus ownership; fixed-row keyed lists/tables with true observed resize, scroll-to-index, edit/focus preservation and stress evidence. Native formatter providers remain embedding-owned; no bundled native ICU binding is claimed.
- P5: this read-only compiler study and the correctness-gated recorded BVH matrix; compiler SIMD/thread/f32 changes are **not** implemented or authorised under this brief.

Remaining external acceptance is explicit: macOS 26 hardware, physical iOS 26 with authorised signing, physical Android WebGPU and Windows/WebView2 execution. Application product choices (fallback UX, app-specific assets/rendering requirements and device coverage) remain application-owned, not hidden framework substitutions. No house-planner or scriptc source files/refs were changed. scriptc integration-history changes were not performed.

## Subsequent evidence

Physical Android acceptance is now available on the S24 Ultra: [device record](ANDROID-S24-ACCEPTANCE.json). It verifies the worker GPU lane and lifecycle without SharedArrayBuffer; WebView response headers alone did not enable cross-origin isolation. The earlier blocked-device matrix remains a dated historical record. The real-scene Bresso tracer measurement is recorded independently in house-planner's `bench/scriptc-bvh/shared-run.json`: 14,998 triangles, three lanes and 41 trials/8 warmups. Its existing dataset is explicitly non-exclusive and complements rather than replaces the synthetic matrix above.

## Compiler follow-up (2026-11-05)

The later compiler-fix authorization covers all five reported defects and the reported tuple, `var`, widened `??` and initialized callable-property cases. See [SCRIPTC-INTEGRATION-FIXES.md](SCRIPTC-INTEGRATION-FIXES.md) for source revisions, removed house-planner workarounds, regression/integration evidence and explicit validation/platform qualifications. Historical P1–P5 acceptance and benchmark records remain unchanged. The later ten-item recheck is not fully closed: pack override selection and general callable-property forms remain partial; f32 compute, wasm SIMD and shared-memory wasm threads remain open.
