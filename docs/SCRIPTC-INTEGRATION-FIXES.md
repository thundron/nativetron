# Compiler integration follow-up — 2026-11-05

The internal scriptc fork repairs the earlier integration cases and admits the bounded language forms described below. This does **not** close the entire ten-item checklist in house-planner's `docs/SCRIPTC-FIXES-2026-11.md`; the recheck below identifies remaining work. Compiler changes are application-neutral; no runtime dependency or native geometry engine was added. Product fixes include `3197aa487`, `a6c29befb`, `d4a068cf1`, `6c57e41d2` and `01637f56a`; subsequent validation fixtures tighten native-only execution and select the trusted Darwin linker where required.

## Ten-item checklist recheck

Rechecked against scriptc `4efeaec9b` using the original retained study repros and focused regression tests. Five items are closed for the reported cases, two are partial and three remain open. The earlier completion wording was too broad for this checklist.

| Item | Status | Evidence or remaining work |
| --- | --- | --- |
| 1. JSON checked casts and library packs | **Partial** | Native fresh/cached archives and both wasm drivers pass checked-cast linking tests; feature forwarding and pack units are fixed. The library loader still ignores `SCRIPTC_RUNTIME_PACK`. |
| 2. Imported JSON keys/order | Closed | Own-key presence, ordering and serialization match Node in the JSON corpus repro. |
| 3. String/byte export results | Closed | Both wasm drivers pass owned-result, memory-growth and cleanup tests. Host-import returns remain scalar-only. |
| 4. Coverage/library mismatch | Closed | Profile-aware library coverage and actual reached Node bridge plans have regression tests. Coverage remains a preparation check, not proof of successful linking. |
| 5. Runtime-index tuple writes and widened `??` | Closed for reported forms | Original `b.ts` and `a.ts`/`a2.ts`/`a3.ts` compile natively and match Node. Mixed-element tuple writes remain explicitly refused. |
| 6. f32 compute contract | **Open** | Float32Array storage and incidental LLVM narrowing are not a supported f32 arithmetic contract; ordinary `number` arithmetic remains f64. |
| 7. Wasm SIMD | **Open** | No reactor SIMD feature/profile/cache/optimizer integration or vectorized-kernel acceptance was added. |
| 8. Transitive workspace JS beside declarations | Closed | Source-only workspace admission has a transitive declaration-twin regression; installed-package admission stays enforced. |
| 9. Early `var` reads and functions with properties | **Partial** | Original `c.js` matches Node. Initialized module-level callable intersections work, but the original `d.ts`, `d2.ts`, `d3.ts` and `d4.ts` still fail with SC1090: call-signature object property access and `Object.assign` function construction remain unsupported. |
| 10. Shared-memory wasm threads | **Open** | A dedicated engine Worker and independent wasm instances are not a shared-heap threading ABI. Native thread-instance support does not close this wasm gap. |

The pack-override probe passed a deliberately nonexistent `SCRIPTC_RUNTIME_PACK` to `loadRuntimePack` in library mode; it nevertheless selected the installed Darwin pack. `backend/runtime-pack.ts:162` resolves the installed package without consulting that override, and `backend/library-pack.ts:86` calls it without an override root. Callable repro failures are separate from the supported initialized intersection case: `frontend/type-mapper.ts:7909` still restricts hybrid mapping to intersections, and `frontend/lowering/lower-calls.ts:10523` retains the `Object.assign` refusal.

The audit's selected checks pass: nine coverage/pack-matrix assertions and five native/wasm checked-cast/owned-result assertions. These are filtered test runs, not an exhaustive-suite claim. No new performance measurements or thread/SIMD/f32 acceptance claims were made.

## Defects

- Imported JSON arrays preserve each record's own-property presence and enumeration order, including prototype-like names, instead of materializing the union of every element's keys.
- Library feature selection, cache records, archive linking and runtime-pack matrices retain declaration-adoption and type-origin units. Checked unknown casts link in native and wasm libraries, including fresh and cached native archives under ASan.
- Both compiler drivers emit wasm host modules supporting owned string, byte and C-string export results. Staging is released on traps, returned bytes are copied, and reads refresh memory after growth. Host-import returns remain scalar-only; borrowed callback buffers remain read-only.
- Source-only workspace packages can reach generated JavaScript through another package without adjacent declarations hiding the implementation. Installed-package source admission remains enforced.
- `coverage --lib --profile ...` checks the profile's export roots, static-only policy and library fences. Package source admission, report-only Node-island candidates, native lowering and linking remain separate facts. The `nodeExecution` field and `Node bridge plan` line now use the executable preparer's reached graph and retry/fallback policy, rather than guessing placement from the candidate table. Reached runtime fences and unresolved policy candidates prevent an unqualified fully-static summary.

An additional validation-discovered helper defect is fixed: partition-local LLVM contexts now outlive target-machine cleanup, including AArch64 selector tracking metadata. A sampled orphan had spun in metadata cleanup; a repeated cold partitioned-coroutine test with freed-memory scribbling guards the lifetime ordering.

## Language forms

- Homogeneous tuples written through runtime indices use growable shared array storage. Tests cover generic aliases, holes, length growth, negative/fractional property keys and receiver/key/value evaluation order.
- Direct JavaScript `var` reads before assignment observe undefined. TypeScript definite-assignment checks remain enforced.
- Record-widening `??` checks the original nullish value before taking a shared checked native view; defaults remain lazy and mutations and identity survive the view.
- Initialized module-level function declarations can flow into matching callable intersection types. Declaration and alias property writes share storage; strict identity and typed `typeof` are preserved.

Mixed-element tuple writes, uninitialized required function properties, opaque/capturing extra-property width views and callable property enumeration retain explicit refusals. These changes do not claim unrestricted JavaScript function-object compatibility.

## Integration evidence

House-planner `8294d4a` removes the three appliance-generator `??` workarounds and the standalone-validator `var` rewrite. Native, WASI command and reactor domain builds each match Node's 64 lines; the reactor also passes profile-aware coverage. All 456 application tests and the typecheck pass. Generated validators remain checked-dynamic native code, not uniformly statically typed statements.

The three-free tracer builds and passes correctness in V8, release wasm and speed wasm on the captured Bresso dump: 14,998 triangles, 965 meshes, six cross-lane comparisons of seven hashes matching the recorded render-pipeline results, and six rejected corruption probes. The current project fixture differs from that dump. No new timing dataset was recorded or substituted for the historical non-exclusive measurements.

Rebuilt nativetron engine/GPU modules pass real Chrome main/Worker WebGPU conformance, readback/restart/lifecycle checks and compiled component, virtual-list, command-palette and i18n tests. Physical S24 evidence remains separately dated in [ANDROID-S24-ACCEPTANCE.json](ANDROID-S24-ACCEPTANCE.json): that user-run APK predates these compiler fixes and is not presented as a new-device run.

## Validation qualification

Validation uses Node 24.22.1 and LLVM 22; Apple Clang 21 cannot lower the current coroutine IR. The Darwin executable-cache proof test separately selects the trusted Apple driver for its object-only link.

Build, lint, formatting and the 25 documentation checks pass. The change series also passed all 5,592 recorded TS7 preflight entries, focused native release/dev/ASan and WASI language comparisons, and integration checks. Final contract runs pass 218 coverage/npm checks, 129 focused library/glue/workspace checks (one platform skip), 17 native-helper checks and 82 selfhosting checks. The ordinary ASan run completed with 7,440 passing assertions and 284 skips. These overlapping run counts are not a unique aggregate. The production CLI also completed its Node-unavailable bootstrap under ASan, including self-rebuild and LLVM fixed point.

All 57 benchmark workloads have identical normalized IR, LLVM and executable artifacts against `76dc1100e`. The strict quick gate passes 56 workloads; the complete gate retains the unchanged baseline `inspect-getters` dynamic-symbol purity failure on this Darwin configuration. Quick comparisons contain no runtime timing measurements. Completed whole-file/corpus shards are retained; earlier contended timeouts are not counted as passes. A single exhaustive latest-revision run is **not complete**: the full differential corpus, large Effect/Three/npm compatibility files and unsanitized production-driver bootstrap have not all been re-established together after the last changes. Earlier large compatibility passes and the successful ASan bootstrap do not turn that into an all-green final gate.

Native differential fixtures now explicitly disable automatic Node retries unless marked as requiring libnode. This makes their native-execution claim testable. ICU-dependent fixtures declare that optional requirement rather than unexpectedly selecting Node or failing due to the local pack's missing ICU objects.
