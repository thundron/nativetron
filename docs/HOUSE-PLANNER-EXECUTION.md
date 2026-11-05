# House-planner completion ledger

Baseline: `5c48621`; all nine streams and the evidence pipeline are integrated; tested source revision `64c9e65`. This is an implementation/integration ledger, not a declaration that platform verification is complete. scriptc and house-planner source and refs remain read-only. No new third-party runtime dependencies; no native GPU implementation; no per-frame native/page GPU traffic.

## Frozen integration seams

- Engine IPC remains version 1 from `ipc/engine.json`: native/UI/engine lanes, 64 KiB payload, 16-byte header, 60 control messages/second. Only the integrator changes the schema/generators.
- `ipc/control-profile.json` owns the native/static-library control client. Build with `SCRIPTC_TARGET=<target> ipc/build-control.sh`; outputs are `ipc/.scriptc/control.lib.a` and IR. `ipc/control.generated.h` is generated from the profile. Register `controlSend` and `controlReceive` before use. Callbacks are synchronous and userdata-first; copy borrowed bytes and queue page/native work after the callback returns. One thread owns the library instance. No outbound FFI, promises or timers.
- `nt_control_command(double topic, const uint8_t *payload, size_t length)` emits a native→engine COMMAND with requestId 0; additive `nt_control_send(frame, length)` preserves the complete native→engine frame (including request id/kind); `nt_control_receive(const uint8_t *frame, size_t length)` validates engine→native routing and invokes the receive callback. Return 0 succeeds, 1 refuses invalid input. Init/collect/registration symbols are in the generated header.
- GPU protocol 3 uses guest-export readback delivery; callback byte views are read-only. Public staging/import contract remains `gpuPresent(batch, uploads, readbacks)`; command schema evolution is owned by the GPU stream. Loader and platform consumers do not hand-author GPU wire bytes.
- Engine entry contract remains prefix-named `start`, `frame`, `event(type, requestId, handle, status, value, text)`, `message(topic, bytes)`, and host callbacks `gpuPresent`, `gpuReport`, optional `engineSend`. Additive `receive(fullFrame)` preserves all envelope fields and correlation identifiers; `readback(offset, bytes)` copies staged host data into the guest before MAP_READY. Preserve `startEngine`, `send`, `mode`, `reason`, `dispose`; additive lifecycle/restart APIs are allowed.
- i18n keeps `message`, argument helpers, `locale.get`, `setLocale`, number/unit formatting and formatter callback signatures. Only the i18n owner changes catalogues. Command labels already used by the palette remain available.
- Virtualisation keeps existing call signatures working. Reactive viewport APIs may be additive. New shared event ABI fields require integrator ownership.

## Ownership and acceptance

| stream | files owned | implementation/verification obligation | status |
|---|---|---|---|
| GPU | `gpu/`, except recorded benchmark artifacts | complete descriptors, negotiation, lifetime/state rules, terminal async ownership, protocol identity, readback/upload safety, real-GPU conformance | implemented; Chrome main/worker conformance verified |
| engine | `engine/host.js`, `engine/worker.js`, `engine/reactor.js`, engine lifecycle tests/docs | robust startup/fallback, cancellation, graceful shutdown, restart, bounded routing/queues, no reentry | implemented; Chrome lifecycle + WK native-menu verified |
| iOS | `hosts/ios/` | actual scriptc static control library, assets, bridge, lifecycle, simulator/device runners, signing safety | implemented; SDK/static-library/simulator verified; physical GPU blocked |
| Android | `hosts/android/` | actual scriptc static control library, JNI/platform message bridge, offline assets, lifecycle, APK/device runners | implemented; JNI/APK/emulator verified; physical GPU blocked |
| Windows | `hosts/windows/` | WebView2 MIME/isolation headers, native messaging/menu, offline policy, lifecycle and runtime acceptance runner | implemented; x64 PE/policy/runner verified; Windows execution blocked |
| i18n | `i18n/`, `locales/` | supported message/plural contract, multiple-catalogue reactive proof, static missing keys, bounded native/page formatting hooks | implemented; compiled wasm/native proof |
| commands | `commands/` | enabled/translated commands, keyboard navigation, focus restoration, shortcut ownership, disposal | implemented; compiled browser proof |
| virtualisation | `framework/virtual*`, `framework/VIRTUAL.md` | geometry, reactive size, identity/edit/focus, shrink/reorder/jumps and disposal | implemented; observed resize/scroll/focus/stress proof |
| P5 | `bench/engine-bvh/`, `docs/HOUSE-PLANNER-GAPS.md` | original-precision and Float32 variants, adverse distributions, validation/harness, read-only compiler evidence | delivered; read-only study + final 28-case matrix |
| integrator | shared IPC/ABI, control client, asset manifest/packaging, root checks, final ledger/report | integrate signed commits linearly, run final full acceptance and exclusive benchmarks, reconcile every requirement | delivered; 43 passed / 0 failed / 6 blocked |

Agents do not run final timing measurements, launch shared simulators/devices, push, modify scriptc/house-planner, or spawn children. Each owns an isolated ephemeral worktree, commits only its files with `Signed-off-by: thundron <la@thundron.dev>`, and returns a clean tree. Clean terminal worktrees are removed automatically; dirty terminal trees must be resolved before further modifying agents or completion.

## Final evidence gates

1. Generated files and protocol identity checks; native control-client ABI and routing conformance.
2. Protocol/state/ownership and component suites; repeated mount/disposal and worker restart/shutdown tests.
3. Real Chrome main/worker GPU checks; macOS WKWebView native menu/engine test and unavailable-GPU path.
4. Build/install/run evidence for iOS, Android and Windows; externally unavailable hardware remains explicitly blocked, never passed by a mock or cross-build.
5. Serialize final GPU and CPU measurements after all modifying agents stop. Separate guest encoding, decode, CPU API calls and queue completion; retain raw samples and correctness gates.
6. Clean repositories, no obsolete worktrees/build clones, no push. Final report lists actual completion, limits and external blockers.

## Serialized verification

```sh
export PATH=/tmp/node-v24.22.1-darwin-arm64/bin:$PATH
export SCRIPTC=/Users/thundron/Documents/development/scriptc/packages/cli/dist/main.js
export WEBVIEW2_SDK=/tmp/nt-webview2-sdk
node scripts/verify-house-planner.mjs --quick
# Full codegen, contracts, compiled/browser/native/platform suites, builds and BVH correctness:
NT_ANDROID_SERIAL=<explicit-serial> node scripts/verify-house-planner.mjs
# Emulators additionally require NT_ANDROID_ALLOW_EMULATOR=1; the runner never launches one.
# Stop all agents/builds/simulators/emulators before the exclusive recording phase:
NT_MEASURE_EXCLUSIVE=1 node scripts/verify-house-planner.mjs --measure-only
```

The root gate writes `build/acceptance/report.json` and per-check logs, uses one test worker, fails fast, records read-only checkout/ref snapshots and artifact SHA-256 hashes, and keeps hardware blockers separate from passing builds or host-only fallback tests. Exit 0 means no blocker, 1 means failure, 2 means explicit external blockers. `--measure-only` reuses a successful full gate at the same source revision; timing artifacts retain their raw samples. `--measure` can run both phases together only on an otherwise idle host. SDK/runtime prerequisites are documented in each host README. PowerShell runner tests need `pwsh` on PATH; skipped optional tests are reported as counters, not represented as executed.

Final verified evidence: Chrome main/worker full GPU descriptors and conformance; native↔engine request-ID preservation; shader diagnostics, loss/restart and no idle loop; 1,210 virtual mount/dispose cycles including real resize/scroll; three compiled reactive catalogues and native/page formatter adapters; mobile real static-library harnesses; iOS 18.6 simulator host/control/assets/lifecycle acceptance; Android 36 arm64 emulator host/control/assets/lifecycle acceptance with WebView 156.0.8078.47; unsigned iphoneos link; signed permissionless Android APK; Windows x64 PE/portable policy/PowerShell runner tests. Both mobile runtimes honestly report unavailable WebGPU. Final gate and exclusive recording completed with 43 passed checks, zero failures and six explicit blocked gates. The six comprise two unavailable-GPU simulator/emulator gates plus four unavailable hardware/runtime gates, not six implementation failures.

## Final result

- Source gate: `64c9e65`; later changes are recorded datasets/documentation only. [Serialized evidence](HOUSE-PLANNER-ACCEPTANCE.json) retains commands, artifact hashes, read-only snapshots and per-check log paths. The local full logs remain under `build/acceptance`.
- Focused Node contracts: **113/113**, single worker, zero skips. Windows portable/PowerShell tests: **8/8**, zero skips (PowerShell 7.6.9 used as a temporary test tool, not a runtime dependency). Native click/lifecycle, Node/React bindings, compiled components/palette/virtualisation, Chrome GPU/engine/lifecycle, and macOS 27 native menu all pass.
- iOS: both SDK builds link actual scriptc archives, 71-assertion compiled host harness, and real iOS 18.6 simulator two-cycle assets/control/background/foreground/release proof. Android: ASan/UBSan real-library host checks, Java policy, permissionless production APK retained separately, 16-KiB-page Android 36 emulator JNI/assets/control/lifecycle/reopen proof. Their GPU unavailable results are recorded, not passed as physical WebGPU. Windows x64 PE, portable policy and PowerShell acceptance-runner checks pass; no Windows execution is claimed.
- Exclusive GPU recording: 101 raw trials/20 warmups with distinct guest encoding, lower-bound decoding, CPU API calls and queue-completion waits. GPU readback validates upload endpoints before/after; both compiled benchmark batches decode exactly. Data: `gpu/last-run.json`.
- Exclusive BVH recording: 28 cases × three lanes, 21 paired trials/5 warmups, original f64 and mechanical f32 variants, seven distributions, genuinely changed refits, full correctness/provenance gates. Data: `bench/engine-bvh/last-run.json`; interpretation in the gap report. No compiler performance feature is silently enabled.
- All nine ephemeral worktrees were automatically removed; only the main nativetron worktree remains. Obsolete legacy iOS derived data and the temporary PowerShell tool are removed. No push, prohibited signing identity, third-party runtime dependency, scriptc/house-planner source/ref change, or application-specific framework code was introduced.

## Subsequent physical Android acceptance (2026-11-05)

The user ran `hosts/android/run.sh` on an S24 Ultra (SM-S928B, API 37, WebView 156.0.8078.47). The runner's APK hash matches the retained local APK and both launches report worker mode and `GPU_READBACK_OK 4096`; native control, response probes, background/resume, post-resume command delivery, disposal/relaunch and offline checks pass. [The imported physical-device record](ANDROID-S24-ACCEPTANCE.json) closes the previously blocked physical Android gate for that configuration. The earlier six-blocker aggregate is a historical snapshot, not a claim that the phone remains untested. No new device run was performed to claim the subsequent compiler fixes are covered by this APK.

The page reports `crossOriginIsolated: false` despite COOP/COEP. Dedicated Worker WebGPU works; shared-memory wasm threads remain unavailable in the tested Android WebView. Physical iOS 26, macOS 26 and Windows runtime acceptance remain separate outstanding hardware gates.

## Compiler follow-up (2026-11-05)

The later compiler-fix authorization covers all five reported defects and the reported tuple, `var`, widened `??` and initialized callable-property cases. See [SCRIPTC-INTEGRATION-FIXES.md](SCRIPTC-INTEGRATION-FIXES.md) for source revisions, removed house-planner workarounds, regression/integration evidence and explicit validation/platform qualifications. Historical P1–P5 acceptance and benchmark records remain unchanged.
