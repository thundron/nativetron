# Binned-SAH BVH: V8 versus scriptc wasm

This harness runs the same TypeScript under V8 and as scriptc wasm32-wasi reactors. It has no house-planner import or runtime dependency.

| file | contents |
|---|---|
| `algorithm-f64.ts` | house-planner `packages/render/src/gi/binned.ts`, verbatim below a 3-line header. The body's SHA-256 is `be032a6c…f9cce7a5`. This is the original Float64 precision. |
| `algorithm-f32.ts` | renderer-facing variant: the same body with every `Float64Array` replaced by `Float32Array`, and nothing else. Bounds, centroids, bin boxes and areas are Float32; order stays Uint32. |
| `workload.ts` | deterministic distributions; the triangle-bounds prologue of `buildWideBvh` and the binary refit loop of `refitWideBvh` (`rt/wbvh/builder.ts`); changed-geometry deformation; validators; exact bit hashes |
| `profile.json`, `profile-speed.json` | the same exports under scriptc's default `release` posture and its `speed` posture |
| `f32-probe.ts`, `profile-f32-*.json` | f32 lowering probe used by `inspect.mjs` |

`run.mjs` checks provenance on every run. The f64 body must hash to the recorded original and must match the live house-planner file when one is available (`HOUSE_PLANNER`, default `~/Documents/development/house-planner`). The f32 body must be exactly the mechanical substitution.

## Workloads

Triangles use house-planner's SceneBuffers stride of 12 floats. Each distribution is generated from an integer LCG with IEEE-exact arithmetic only, so every lane receives bit-identical input. Cross-lane input hashes confirm this.

| id | distribution | purpose |
|---|---|---|
| 0 | `architectural` | typical: room-scale boxes, 12 triangles each, plus zero-thickness wall panels |
| 1 | `uniform-soup` | typical: the previous harness's small equal triangles |
| 2 | `coincident-centroids` | adverse: every centroid is identical, which forces the halve-the-range fallback at every node |
| 3 | `geometric-clusters` | adverse: 48 clusters at x≈2⁻ᵏ, so each split peels off about one cluster and the tree is deep |
| 4 | `long-slivers` | adverse: 100 m slivers with heavily overlapping boxes |
| 5 | `far-offset-mm` | adverse: mm–cm parts 4 km from the origin, where Float32 quantisation applies |
| 6 | `planar-duplicates` | adverse: a single plane, each triangle repeated 8×, a zero-extent axis and identical centroids |

## Timed windows

Each window runs once per lane, back to back. Lane order rotates by trial and case, and variant order alternates by trial. Warmups use the same schedule, and their samples are retained separately.

| phase | includes | excludes |
|---|---|---|
| `allocate` | only the typed arrays buildBinary allocates, with the same fills. This probe cannot be subtracted from `build`. | build work |
| `bounds` | triangle AABBs and centroids into new arrays, as buildWideBvh computes them | — |
| `build` | `buildBinary` with its own allocations | releasing the previous tree |
| `refit` | binary refit after a changed-geometry deformation. No allocation. | the deformation itself |

Generation, reset, deformation, release, validation, hashing and instantiation are never timed. Nothing forces garbage collection. The generated glue does not wrap the module's `bvh_collect` export, and calling V8's `gc()` without a wasm counterpart would be asymmetric. V8 GC pauses can therefore land inside any V8 window. The wasm lanes free the previous tree through reference counting during `release`, outside the windows.

Builds always start from the undeformed mesh, so every trial must reproduce the same topology and box hashes. Before each refit, `deform(frame)` moves every triangle by a frame-dependent amount from the base mesh. The run requires at least half the triangles to change after Float32 storage. Refit must then leave topology unchanged, must change the node-box hash, and must still validate exactly.

## Correctness gates (every trial, every lane)

- `validate()` runs in every lane after build and after refit. It checks the node count, root range, child indices following parents, parent multiplicity, range partition, leaf shape, permutation, exact leaf boxes against the current triangles, and that internal boxes are the exact child union.
- Exact IEEE-754 bit hashes must be equal across lanes. They cover triangles, bounds/centroids, topology and order, and node boxes.
- A separately written JS validator walks the V8 tree after the first build and after the first and last refit. It also reports depth and the SAH ratio (Σ node half-areas / root).
- A self-test corrupts V8 trees six ways per variant. Both validators must reject every corruption.
- The f32 probe values must match across lanes.

## Commands

Use the official Node 24.22.1 build; the harness checks its ICU pairing.

```sh
export PATH=/tmp/node-v24.22.1-darwin-arm64/bin:$PATH
SCRIPTC=/Users/thundron/Documents/development/scriptc/packages/cli/dist/main.js bench/engine-bvh/build.sh
node bench/engine-bvh/run.mjs                 # smoke: sizes 1,2,3,17,1000,4096; no timings printed; writes nothing
SIZES=50000 node bench/engine-bvh/run.mjs     # smoke at the final size (correctness only)
node bench/engine-bvh/inspect.mjs             # IR/binary facts: f32 lowering, opcode census, memory/imports
```

Run the final measurement only on an otherwise idle machine, after all builds and agents have stopped:

```sh
NT_BVH_EXCLUSIVE=1 node bench/engine-bvh/run.mjs --final
```

The defaults are `SIZES=4096,50000`, `WARMUPS=5`, `TRIALS=21` and `LANES=v8,release,speed`. Final mode writes `last-run.json` (or `NT_BVH_OUTPUT`). The file holds every raw and warmup sample, the lane orders, deformation counts, per-trial paired wasm/V8 ratios, system load before and after, module hashes and memory sizes, and the correctness record.

`last-run.json` currently holds the **previous harness revision's** result from 2026-11-04T19:01Z. That revision ran a single Float32 variant on one uniform distribution with the release lane only, and its timed refit used unchanged geometry. It is superseded and is not comparable with this harness. It stays in place until the exclusive final run replaces it.

This is a CPU microbenchmark of the binary builder and refit. It does not cover the CWBVH collapse, quantisation or the triangle repack, a browser or device, or a complete renderer frame. SIMD and shared memory are not enabled. See [the gap report](../../docs/HOUSE-PLANNER-GAPS.md).
