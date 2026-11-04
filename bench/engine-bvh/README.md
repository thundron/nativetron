# Typed-array BVH comparison

A local adaptation of house-planner's 16-bin SAH builder, using Float32Array geometry/bounds and Uint32Array order. The same source runs under V8 and as a scriptc reactor. There is no house-planner import or application dependency.

```sh
PATH=/tmp/node-v24.22.1-darwin-arm64/bin:$PATH bench/engine-bvh/build.sh
/tmp/node-v24.22.1-darwin-arm64/bin/node bench/engine-bvh/run.mjs
/tmp/node-v24.22.1-darwin-arm64/bin/node bench/engine-bvh/inspect.mjs
```

Use an official Node 24.22.1 installation; the harness checks its ICU pairing. The path above is the installation used here. `run.mjs` writes all samples and system metadata to `last-run.json`. Five warmups precede 21 paired/interleaved trials. Instantiation, deterministic triangle generation and full validation/checksums are outside timing. Build includes allocation; refit recomputes leaf boxes from triangles and internal boxes bottom-up. No forced GC is applied to either lane.

| 50k-triangle workload | V8 median | wasm median |
|---|---:|---:|
| build, 99,999 nodes | 85.12 ms | 99.56 ms |
| refit | 1.13 ms | 1.48 ms |

Apple M4 Max, macOS arm64, V8 13.6.233.17-node.58. Every trial validates leaf/parent geometry, unique primitive coverage and complete topology/bounds/order checksums. A separate deformed-triangle refit confirms observable changes. This is a CPU microbenchmark, not the complete renderer, an unmodified production WBVH build, or a browser/device performance result. SIMD and shared memory are not enabled.

`inspect.mjs` asserts the emitted f32 probe's float loads/stores, f64 arithmetic and explicit fround truncation/promotion. It also verifies that the actual reactor's linear memory is unshared. See [the gap report](../../docs/HOUSE-PLANNER-GAPS.md) for source evidence and effort estimates.
