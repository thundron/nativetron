# House-planner integration gaps

I inspected scriptc `internal` at `76dc1100ef9a45ad91ca52760534c611d13eb1d3` (0.4.8) and house-planner at `119c919` (study §7.6, `gi/binned.ts`, `rt/wbvh/`). Both checkouts were read only, and no files or refs were changed. The benchmark code is a local copy, not a runtime dependency. Line references below are to that scriptc revision. The binary facts come from `bench/engine-bvh/inspect.mjs`, which uses a dependency-free opcode census, run on reactors built locally with `SCRIPTC=…/scriptc/packages/cli/dist/main.js`.

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

**Pending:** final timings. The exclusive run happens after integration (`NT_BVH_EXCLUSIVE=1 node bench/engine-bvh/run.mjs --final`), and this section should then be replaced with its medians, paired ratios and spread.

`last-run.json` still holds the previous revision's result, recorded at 2026-11-04T19:01Z under these conditions:

- one Float32 variant
- the uniform distribution only
- release lane only
- unchanged-geometry refit

Its V8/wasm medians were 85.12/99.56 ms for build and 1.13/1.48 ms for refit at 50k triangles on an Apple M4 Max. Those numbers are superseded and are not evidence for the new variants, distributions or postures.

Scope limits:

- The CWBVH collapse, quantisation and triangle repack are not copied.
- house-planner's Bresso fixture is not used: no house-planner data is imported. S1's "36 ms build, 2.5 ms refit, 20 ms extraction" is therefore not reproduced here.
- Browser, Windows, Android and iOS CPU results are not measured.

## Framework/platform delivery and remaining scope

This summary is conservative. The iOS, Android, Windows, engine, GPU, i18n, commands and virtualisation streams are still being integrated (see `docs/HOUSE-PLANNER-EXECUTION.md`), and the integrator's final ledger supersedes this section.

- Baseline `5c48621` provides a generated WebGPU command surface with transport measurements in `gpu/README.md`, an in-page engine reactor lane with generated bounded control IPC, platform host shells, and English-first i18n, commands and fixed-row virtualisation. The respective READMEs describe what was exercised at that baseline.
- Runtime verification on Android devices, Windows, physical iOS devices and iOS WebGPU is not claimed here. A cross-build or mock is not runtime evidence.
- The GPU surface is deliberately not a complete WebGPU binding; its schema and its limits are owned by the GPU stream.

Open questions:

- Which render targets, features and formats does the first engine milestone need?
- Should an unavailable WebGPU disable 3D editing or offer a separately scoped fallback?
- Which physical devices form the acceptance matrix?
- For SIMD, should work begin with reactor feature plumbing (above) or with profiling the scalar BVH loops once final timings exist?

scriptc integration-history changes were not performed under this read-only brief.
