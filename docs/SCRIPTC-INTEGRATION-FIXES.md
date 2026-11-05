# Compiler integration follow-up — 2026-11-05

The internal scriptc fork fixes the five defects and the four reported language forms from house-planner study §7.8. Compiler changes are application-neutral; no runtime dependency or native geometry engine was added. Product fixes include `3197aa487`, `a6c29befb`, `d4a068cf1`, `6c57e41d2` and `01637f56a`; subsequent validation fixtures tighten native-only execution and select the trusted Darwin linker where required.

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
