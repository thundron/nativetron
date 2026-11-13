# Native reactor host (`gpu/native/reactor/`)

A native host for scriptc library-mode engine reactors (house-planner's `hp-engine`) that runs the engine's GPU
op stream on a protocol-3 executor through the shared C API in [`../executor.h`](../executor.h), plus the
harness that replays real house-planner sessions through it and captures the final RGBA.

Status: host, guests, harness, fixtures and comparisons are complete and tested against a MOCK executor
(`mock-executor.cc`, a recording double). Image claims need the real executor (`gpu/native/executor.cc`, another
lane): link it with `build.sh --executor-archive …` and run `e2e.sh`. Nothing here measures performance.

## Pieces

| file | role |
| --- | --- |
| `reactor.h`, `reactor.c` | host core (plain C, reusable as the Swift/ObjC platform shim): guarded serialized exports, executor event queue, frame requests, event mapping, pump |
| `guest-native.c` | in-process guest: a static archive (`native:linked`) or a dylib (`native:<path>`), exports `<prefix>init/sink/callback/start/frame/event/message/receive/readback` |
| `guest-pipe.c` | guest in a child process over fds 3/4 (`native-process:<dylib>`, `wasm:<dir>`), and the child-side server (`nt-reactor guest`) |
| `wasm-guest.mjs` | the wasm32-wasi reactor (`hp-engine.mjs` + `.wasm`) in Node/V8 behind the same pipe protocol |
| `cli.c` | `nt-reactor run | selftest | guest`: script driver, engine-lane decoding, captures, run metadata |
| `json.c` | minimal JSON reader for executor event objects |
| `mock-executor.cc` | MOCK executor (generated decoder + synthetic acknowledgements, zero readbacks, no capture); exports `ntgpu_executor_is_mock` |
| `build.sh` | builds `nt-reactor`, the mock dylib, and optionally `nt-reactor-linked` / `libntgpu-executor.dylib` |
| `sandbox.sh` | read-only consumer sandbox (`git archive`, cloned `node_modules`, regenerated sources, canonical engine wasm) |
| `record-app.mjs` | records a real app session in Chrome (golden / still / panorama / video flows) + Chrome's own captures |
| `scenario.mjs` | compiles scripts: `triangle-oracle`, `triangle`, `app --recording …` (frame-synchronous replay) |
| `post.mjs`, `panorama.mjs`, `png.mjs` | capture → PNG (codec captures via the consumer's `capture-codec.ts`), comparisons, panorama composition |
| `e2e.sh` | every flow × guest against one executor, comparisons, `summary.txt` |
| `test.mjs` | regression suite on the mock (guards, traces vs the prior oracle, app replays native = wasm) |

## Host contract (what `reactor.c` guarantees)

- **Registration before init.** A native guest gets `hp_sink` and the four callbacks (`gpuPresent`, `gpuReport`,
  `engineSend`, `engineOffer`) before `hp_init`; the wasm glue binds imports at instantiation, then runs init.
- **Guard.** Each export runs inside a `setjmp` frame in C (`guest-native.c`), directly around the call. The sink
  longjmps there; only C and guest frames lie between (reactor callbacks have returned before the guest can trap),
  never Swift or ObjC. A trap outside a guarded export aborts rather than resuming the guest.
- **Serialization and reentry.** One owner thread. An export requested while one is active (for example from inside
  `engineSend`) returns `NT_REACTOR_REENTRY` and the guest is not entered (selftest).
- **Queueing.** `gpuPresent` calls `ntgpu_executor_submit(commands, uploads, readback_capacity)` synchronously (the
  executor copies before returning; the readback span is only measured). Executor events and `frame_requested`
  raised during an export are queued and delivered by `nt_reactor_pump` after it. Executor `wake` (any thread)
  only signals a condition variable and the optional host `wake` callback.
- **Event mapping** = `engine/reactor.js` `deliver()`: `MAP_READY` with data (or an `offset`) calls
  `readback(offset, bytes)` **before** `event(…)`; CAPABILITIES passes `timestamp-query` as value and the event
  JSON as text; SHADER_INFO passes the `messages` JSON; RESIZE passes `dpr` and `{"width","height"}`; others
  `message ?? reason ?? ""`. Events emitted during `capture_rgba` are host diagnostics, not delivered to the guest.
- **Poison.** A trap (sink message, wasm throw, dead guest process, pipe violation) poisons the reactor: every later
  export returns `NT_REACTOR_POISONED` without entering the guest (no abort, no `hp_init` on a trapped image).
  Recovery is a new instance: for `native-process:` / `wasm:` a new child process (bounded: the dead one is reaped,
  nothing leaks). An in-process native image cannot be recovered (never dlclose'd; process exit reclaims it).
- **Pump.** Delivers queued events (one per export, readback first), then lets the executor progress
  (`process`), then — in lockstep (`settle`, default) — waits until `pending() == 0` before the next frame, then
  delivers a frame if the engine requested one and the budget allows. The timeout bounds a stall, not a pump.
  Frame times come from a synthetic clock (1000 ms, +1000/60 per frame) so runs are reproducible.
- **Event order.** `--event-order request` sorts each queued group by request id (deterministic under a real GPU,
  used by `e2e.sh`); `arrival` keeps executor order (the mock and the prior oracle).
- **Resize.** `nt_reactor_resize` calls `ntgpu_executor_resize`; with `--resize-event auto` the host synthesizes the
  RESIZE event when the executor did not emit one during the call (as `engine/reactor.js resize()` does).
- **Executor create.** `executor.h` leaves `create`'s return value open; the host treats a non-NULL executor as
  success (the executor and the mock return 1, like `submit`/`capture_rgba`).

## Build

```sh
gpu/native/reactor/build.sh                         # → /tmp/nt-reactor-e2e/build/{nt-reactor,libntgpu-executor-mock.dylib}
# real executor (archive from gpu/native/build-executor.sh) + pinned or patched wgpu-native (NTGPU_WGPU_LIB override):
gpu/native/reactor/build.sh --out /tmp/nt-reactor-e2e/build-real \
  --executor-archive <executor build>/libntgpu-executor.a --executor-archive <wgpu prefix>/lib/libwgpu_native.a \
  --executor-ldflags "-framework Metal -framework QuartzCore -framework Foundation -framework CoreFoundation -lobjc -liconv"
# → nt-reactor-linked (--executor-lib linked) and libntgpu-executor.dylib (exports only ntgpu_executor_*)
# --executor-src <file.cc> … compiles executor sources instead of an archive; --engine-archive hp-engine.lib.a links
# the engine statically (engine spec native:linked). --sanitize address|undefined.
```

Outputs never go into the worktree. The engine artifacts are the canonical outputs of
`/tmp/nt-native-reactor-1` (read-only): `bin/libhp-engine.dylib`, `out/native/hp-engine.lib.a`, `out/wasm/`.

## Run

```sh
nt-reactor run --engine native:<libhp-engine.dylib> | native-process:<dylib> | wasm:<dir> \
  --executor-lib <executor dylib | linked> --script <script.txt> --out <dir> \
  [--width 960 --height 600 --dpr 1] [--event-order request] [--trace trace.txt [--trace-readback-sha]] [--no-settle]
nt-reactor selftest --engine <spec> --executor-lib <mock>
```

Script steps: `start`, `message <topic> <payload>`, `receive <payload>`, `command|bulk|state <topic> <rid> <payload>`
(engine-lane frame from the UI lane), `event <type> <rid> <handle> <status> <value> <text>`, `resize <w> <h> <dpr>`,
`pump [frames]`, `sync-frames <engine frame count>`, `wait-result <rid> [frames]`, `wait-event <topic> <kind|*> [frames]`,
`wait-status <flags> [frames]`, `capture-engine <rid> <name>`, `capture-executor <name>`, `mark <label>`,
`expect-poisoned`. Payloads: `-`, `@file` (relative to the script) or `@/abs`, `hex:…`, `u32:a,b`, `f64:…`, `text:…`.

Per run (`--out`): `run.json` (flags, executor origin and mock flag, counters, engine status, results, captures,
frame-sync divergences), `engine-log.txt` (results, errors, engine events, capture chunks, pump outcomes),
`timepoints.csv` (raw monotonic ns per step with frame/event/present deltas — data for later uncontended runs, not
a measurement), `<capture>.rgba|.enc` + `<capture>.json`, and with `--trace` the crossing trace (`present` spans with
SHA-256, `send`, `offer`, `report`, `ret`, `panic`) in the prior oracle's format.

## Fixtures and capture harness

1. `sandbox.sh` builds `/tmp/nt-reactor-e2e/hp` from the consumer without writing to it (HEAD and porcelain status
   recorded before and after in `provenance/`).
2. `record-app.mjs --flow golden|still|panorama|video` runs the app from the sandbox in headless Chrome (vite with
   `HP_SKIP_ENGINE=1`, the canonical wasm in `public/engine`) and records every page → engine-worker message
   (engine frames, resizes), every engine → page result/event/status, and the bytes of every capture the engine
   sends (Chrome's baseline for exactly that request). `golden` repeats `scripts/golden.mjs --engine` for Bresso
   (`?engine&gidet&tier=desktop`, 960×600, `setView`, `runGi(64)`, `capture()`); `still`, `panorama` and `video`
   call the app's presentation API (`window.hpPresent.still/panorama/video`) in the full app (`?gidet&tier=desktop`).
3. `scenario.mjs app` replays a recording frame-synchronously: before each recorded message the reactor renders up
   to the engine frame count (E_STATUS frames) the page had seen when it sent it, never beyond; awaited results,
   GI runs (`E_GI` run event) and captures are awaited. Page timing (settle waits, timeouts) becomes the engine
   frame it happened at. `--codec-probe` adds raw / lossless / video codec captures of the final view.
4. `post.mjs` turns captures into PNGs and compares: Chrome's capture of the same request, the committed golden
   (`test/golden/engine/bresso-<view>.png`), native vs wasm, codec vs raw. `panorama.mjs` composes the six faces
   with the app's own `present/equirect.ts` and compares with Chrome's panorama (its self-check composes Chrome's
   faces and must be bit-identical to Chrome's result).

Tolerance (from `scripts/golden.mjs`): a pixel differs when an RGB channel differs by more than 12/255; a view fails
when more than 0.5 % of pixels differ; the count of non-bit-identical pixels and the max/mean deltas are reported.
Reproducibility: deterministic GI rays (`gidet`), forced desktop tier, synthetic frame clock, lockstep pump,
request-ordered events; the recordings fix every UI input. GPU float differences between backends (Chrome's
Dawn/Metal vs wgpu-native/Metal) are expected inside the tolerance, not bit-identity.

## Tests

`node gpu/native/reactor/test.mjs` (mock executor): selftests for every guest kind (healthy boot, reentry refused,
trap poisons with the sink message, poisoned exports refused without abort, restart in a new process, dead guest
process detected), the prior oracle's export sequence giving a byte-identical trace on native, native-process and
wasm guests and equal to `/tmp/nt-native-reactor-1/proof/trace-wasm.txt`, the T_CAPTURE path, and every recorded
app flow replaying with byte-identical native and wasm traces.

## Limits

- An executor that aborts the process (a Rust panic across the FFI, e.g. a failing `wgpuQueueSubmit`) takes the
  host down; only guests are process-isolated here, not the executor.
- `capture_rgba` reads the executor's headless target; a CAMetalLayer-backed run (`metal_layer`) is the macOS
  host's job (`hosts/macos/NativeGPUSurface.swift`) and is not exercised by this CLI.
- The iOS-simulator engine archive links but is not run; no instance-per-thread engine is used by the host.
