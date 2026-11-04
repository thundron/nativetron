# House-planner completion ledger

Baseline: `5c48621`. This is an implementation/integration ledger, not a declaration that platform verification is complete. scriptc and house-planner source and refs remain read-only. No new third-party runtime dependencies; no native GPU implementation; no per-frame native/page GPU traffic.

## Frozen integration seams

- Engine IPC remains version 1 from `ipc/engine.json`: native/UI/engine lanes, 64 KiB payload, 16-byte header, 60 control messages/second. Only the integrator changes the schema/generators.
- `ipc/control-profile.json` owns the native/static-library control client. Build with `SCRIPTC_TARGET=<target> ipc/build-control.sh`; outputs are `ipc/.scriptc/control.lib.a` and IR. `ipc/control.generated.h` is generated from the profile. Register `controlSend` and `controlReceive` before use. Callbacks are synchronous and userdata-first; copy borrowed bytes and queue page/native work after the callback returns. One thread owns the library instance. No outbound FFI, promises or timers.
- `nt_control_command(double topic, const uint8_t *payload, size_t length)` emits a native→engine COMMAND with requestId 0; `nt_control_receive(const uint8_t *frame, size_t length)` validates engine→native routing and invokes the receive callback. Return 0 succeeds, 1 refuses invalid input. Init/collect/registration symbols are in the generated header.
- Public GPU staging/import contract remains `gpuPresent(batch, uploads, readbacks)`; command schema evolution is owned by the GPU stream. Loader and platform consumers do not hand-author GPU wire bytes.
- Engine entry contract remains prefix-named `start`, `frame`, `event(type, requestId, handle, status, value, text)`, `message(topic, bytes)`, and host callbacks `gpuPresent`, `gpuReport`, optional `engineSend`. Preserve `startEngine`, `send`, `mode`, `reason`, `dispose`; additive lifecycle/restart APIs are allowed.
- i18n keeps `message`, argument helpers, `locale.get`, `setLocale`, number/unit formatting and formatter callback signatures. Only the i18n owner changes catalogues. Command labels already used by the palette remain available.
- Virtualisation keeps existing call signatures working. Reactive viewport APIs may be additive. New shared event ABI fields require integrator ownership.

## Ownership and acceptance

| stream | files owned | implementation/verification obligation | status |
|---|---|---|---|
| GPU | `gpu/`, except recorded benchmark artifacts | complete descriptors, negotiation, lifetime/state rules, terminal async ownership, protocol identity, readback/upload safety, real-GPU conformance | dispatched |
| engine | `engine/host.js`, `engine/worker.js`, `engine/reactor.js`, engine lifecycle tests/docs | robust startup/fallback, cancellation, graceful shutdown, restart, bounded routing/queues, no reentry | dispatched |
| iOS | `hosts/ios/` | actual scriptc static control library, assets, bridge, lifecycle, simulator/device runners, signing safety | dispatched |
| Android | `hosts/android/` | actual scriptc static control library, JNI/platform message bridge, offline assets, lifecycle, APK/device runners | dispatched |
| Windows | `hosts/windows/` | WebView2 MIME/isolation headers, native messaging/menu, offline policy, lifecycle and runtime acceptance runner | dispatched |
| i18n | `i18n/`, `locales/` | supported message/plural contract, multiple-catalogue reactive proof, static missing keys, bounded native/page formatting hooks | dispatched |
| commands | `commands/` | enabled/translated commands, keyboard navigation, focus restoration, shortcut ownership, disposal | dispatched |
| virtualisation | `framework/virtual*`, `framework/VIRTUAL.md` | geometry, reactive size, identity/edit/focus, shrink/reorder/jumps and disposal | dispatched |
| P5 | `bench/engine-bvh/`, `docs/HOUSE-PLANNER-GAPS.md` | original-precision and Float32 variants, adverse distributions, validation/harness, read-only compiler evidence | dispatched |
| integrator | shared IPC/ABI, control client, asset manifest/packaging, root checks, final ledger/report | integrate signed commits linearly, run final full acceptance and exclusive benchmarks, reconcile every requirement | active |

Agents do not run final timing measurements, launch shared simulators/devices, push, modify scriptc/house-planner, or spawn children. Each owns an isolated ephemeral worktree, commits only its files with `Signed-off-by: thundron <la@thundron.dev>`, and returns a clean tree. Clean terminal worktrees are removed automatically; dirty terminal trees must be resolved before further modifying agents or completion.

## Final evidence gates

1. Generated files and protocol identity checks; native control-client ABI and routing conformance.
2. Protocol/state/ownership and component suites; repeated mount/disposal and worker restart/shutdown tests.
3. Real Chrome main/worker GPU checks; macOS WKWebView native menu/engine test and unavailable-GPU path.
4. Build/install/run evidence for iOS, Android and Windows; externally unavailable hardware remains explicitly blocked, never passed by a mock or cross-build.
5. Serialize final GPU and CPU measurements after all modifying agents stop. Separate guest encoding, decode, CPU API calls and queue completion; retain raw samples and correctness gates.
6. Clean repositories, no obsolete worktrees/build clones, no push. Final report lists actual completion, limits and external blockers.
