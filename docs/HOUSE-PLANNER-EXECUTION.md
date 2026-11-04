# House-planner completion ledger

Baseline: `5c48621`; all nine streams are integrated through `3b0a5e6`. This is an implementation/integration ledger, not a declaration that platform verification is complete. scriptc and house-planner source and refs remain read-only. No new third-party runtime dependencies; no native GPU implementation; no per-frame native/page GPU traffic.

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
| GPU | `gpu/`, except recorded benchmark artifacts | complete descriptors, negotiation, lifetime/state rules, terminal async ownership, protocol identity, readback/upload safety, real-GPU conformance | integrated; final gate pending |
| engine | `engine/host.js`, `engine/worker.js`, `engine/reactor.js`, engine lifecycle tests/docs | robust startup/fallback, cancellation, graceful shutdown, restart, bounded routing/queues, no reentry | integrated; final gate pending |
| iOS | `hosts/ios/` | actual scriptc static control library, assets, bridge, lifecycle, simulator/device runners, signing safety | integrated; final gate pending |
| Android | `hosts/android/` | actual scriptc static control library, JNI/platform message bridge, offline assets, lifecycle, APK/device runners | integrated; final gate pending |
| Windows | `hosts/windows/` | WebView2 MIME/isolation headers, native messaging/menu, offline policy, lifecycle and runtime acceptance runner | integrated; final gate pending |
| i18n | `i18n/`, `locales/` | supported message/plural contract, multiple-catalogue reactive proof, static missing keys, bounded native/page formatting hooks | integrated; final gate pending |
| commands | `commands/` | enabled/translated commands, keyboard navigation, focus restoration, shortcut ownership, disposal | integrated; final gate pending |
| virtualisation | `framework/virtual*`, `framework/VIRTUAL.md` | geometry, reactive size, identity/edit/focus, shrink/reorder/jumps and disposal | integrated; final gate pending |
| P5 | `bench/engine-bvh/`, `docs/HOUSE-PLANNER-GAPS.md` | original-precision and Float32 variants, adverse distributions, validation/harness, read-only compiler evidence | integrated; final gate pending |
| integrator | shared IPC/ABI, control client, asset manifest/packaging, root checks, final ledger/report | integrate signed commits linearly, run final full acceptance and exclusive benchmarks, reconcile every requirement | active |

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

Integrated evidence already exercised before the final aggregate: Chrome main/worker full GPU descriptors and conformance; native↔engine request-ID preservation; shader diagnostics, loss/restart and no idle loop; 1,210 virtual mount/dispose cycles including real resize/scroll; three compiled reactive catalogues and native/page formatter adapters; mobile real static-library harnesses; iOS 18.6 simulator host/control/assets/lifecycle acceptance; Android 36 arm64 emulator host/control/assets/lifecycle acceptance with WebView 156.0.8078.47; unsigned iphoneos link; signed permissionless Android APK; Windows x64 PE/portable policy/PowerShell runner tests. Both mobile runtimes honestly report unavailable WebGPU. Final gate and exclusive timing results will replace the pending statuses above.
