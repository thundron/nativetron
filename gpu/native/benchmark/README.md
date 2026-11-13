# Native GPU benchmark (`gpu/native/benchmark/`)

Measures the house-planner engine on the real Bresso scene along three kinds of path, with one fixed procedure,
and records raw JSON/CSV with provenance. Results and the go/no-go are in [`RESULTS.md`](RESULTS.md).

| path id | what runs | GPU API | crossing | presentation |
| --- | --- | --- | --- | --- |
| `chrome` | Google Chrome, headed, fresh process per run, the app bundle over loopback HTTP | JS WebGPU (Dawn → Metal) | none (worker owns the device) | visible window (Chrome's compositor) |
| `wk-native` | macOS host (`hosts/macos`) WKWebView, `--native-gpu`, same bundle as `app://dev` | executor (wgpu-native → Metal), in the app process | Worker → binary `WKURLSchemeHandler` wire → executor | none (headless: no public transparent WKWebView) |
| `wk-native-overlay` | same, `--native-gpu-composition=overlay` | same | same | CAMetalLayer above the web view (public API) |
| `cli-native` | `nt-reactor` replaying the recorded session, engine as native dylib | same executor dylib | none (in-process C calls) | none |
| `cli-wasm` | `nt-reactor`, the same Wasm reactor in Node/V8 (child process) | same executor dylib | pipe to the guest process | none |
| `wk-webgpu` | WKWebView's own WebGPU | WebKit → Metal | — | — |

`wk-webgpu` is runnable but **excluded**: WebKit fails to compile the engine's shaders on this OS (`Failed to compile
the shader source, generated metal …`, then `encoder state is not valid` every frame; the gpu-shaders lane traced
the CAS prelude), so its frames are not the scene. The CLI paths are the best-case headless workload numbers for
this engine on this executor; they are never reported as the app path.

## Same input everywhere

- **Bundle** (`build-bundle.mjs`): the consumer at the commit the canonical engine Wasm was built from (`67ffa0c`),
  `git archive` + cloned `node_modules` (see `gpu/native/reactor/sandbox.sh`), with nativetron's `engine/ gpu/ ipc/`
  from the commit under test (`git archive <sha>`) as the `nativetron` link; Vite production build. The consumer
  checkout is never written; the sandbox's sources are not edited either.
- **One bundle-time wrapper** (the only benchmark-specific change): `createEngine` from `nativetron/engine/host.js`
  gets `{ nativeGpu }` when `bench.html`'s bootstrap claimed the host's `window.__ntNativeGpuOffer`. The consumer has
  no native GPU opt-in of its own; without an offer (Chrome) the options pass through unchanged.
- **Page parameters** `?gidet&tier=desktop` (deterministic GI rays, forced desktop tier) via `nt-bench/params.json`
  (`app://dev` drops a `--url` query).
- **Viewport** 1100×760 CSS px at DPR 2 → the engine canvas is 1600×1520 device px on every app path. Chrome emulates
  it (`setViewport`); the macOS host pins the web view with `--benchmark-viewport=1100x760`
  (`hosts/macos/NativeGPUBenchmark.swift`), because the user's tiling window manager resizes the window from run to
  run (measured 1728×1051, 864×1051, 576×1051). A smaller window clips the web view (reported as
  `NT_MACOS_BENCHMARK_VIEWPORT … visible=…`); the page, canvas and render size do not change.
- **CLI input** (`record-bench.mjs`): the same bundle + driver recorded in headless Chrome in
  `gpu/native/reactor/record-app.mjs`'s format; `scenario.mjs app` replays it frame-synchronously. Recording timings
  are not results.

## Procedure (`driver.js`, identical on every app path; mirrors the consumer's `apps/web/src/engine/bench.ts`)

1. **Startup** (page times since navigation, from the app's own `startup`): lane up, scene uploaded,
   **first image** = the first engine status with the scene followed by one more rendered frame, first GI
   convergence. Host-side: process launch → bootstrap line.
2. **Settle**: the engine's `STATUS_SETTLED`, bounded at 20 s. In the full app the direct light stays `pending` and
   the status never settles — also in Chrome (the consumer's own still recording waited out `hpPresent`'s 60 s
   timeout) — so this is recorded (`settleTimedOut`) and the procedure continues at that point; `hpPresent.still`
   latency is opt-in (`?ntStill`) for the same reason.
3. **Still**: LIVING view, `bench(5)` warm-up, 5 × `bench(10)`. **Moving**: `bench(5, move)` warm-up, 6 ×
   `bench(10, move)`. `bench(n)` renders n frames back to back, each after the previous one's GPU completion
   (`onSubmittedWorkDone`), so a frame's wall time is submit → GPU done → completion delivered to the engine: on
   `wk-native` that includes the full wire round trip per frame. Fixed counts; nothing adapts to speed.
4. **GPU timestamps** (`timestamp-query`, all paths expose it): timing on, warm-up, 3 × `bench(10, move)`,
   3 × `bench(10)`, per-pass spans from the engine's stats.
5. **Idle**: settle (bounded), 2 s, then 10 s with nothing requested: engine frames rendered, and the processes' CPU,
   GPU and wakeups over that window.
6. **Image check**: LIVING, `runGi(64)`, `capture()` (the golden procedure), 16×16 box-averaged thumbnail compared with
   the golden rule (channel > 12/255, fail > 0.5 %) against the mode's first Chrome run. A coarse same-scene check;
   the full-size golden/still/panorama/video comparisons are `gpu/native/reactor/e2e.sh`'s.

## Counters and what they mean

- **Frame wall** (`stillFrameMs`, `movingFrameMs`): median of the per-sample means (5 still, 6 moving samples of 10
  frames). The only FPS-like statement made is 1000 / this value for back-to-back GPU-completed frames; display
  frame rate is not measured (no presentation counter is common to all paths).
- **Process CPU** (`proc_pid_rusage` user+system) and **kernel GPU time** (`AGXDeviceUserClient` `AppUsage
  .accumulatedGPUTime` per creating pid) for every process of the launch, sampled by `nt-bench-probe` when the runner
  reads a driver mark (start marks follow a 250 ms quiet period, end marks precede one). Per frame = phase delta /
  frames in the phase (warm-up included in both). Classes: `app` (Nativetron, contains the executor on native
  paths), `content` (WebContent / Chrome renderer: the page and the engine Worker), `gpuProcess` (WebKit GPU / Chrome
  GPU helper), `browser`, `other`. GPU time is the kernel's per-client accounting of all GPU work of that process,
  including presentation; WindowServer's composition is not attributed to any path.
- **GPU timestamps** (`gpuTs…FrameMs`): the engine's own pass spans. On Apple GPUs (TBDR) pass timestamps from
  different implementations are not comparable 1:1 (Dawn and wgpu sample at different encoder boundaries); use the
  kernel GPU time for cross-path comparison, timestamps within a path.
- **Memory**: `trackedMemoryMB` = the engine's own allocation estimate (bench.ts formula: GI, direct, reflections,
  7 render targets + shadow map) — what the engine asked for. `footprintIdleEndMB` = `phys_footprint` per process
  class (physical residency incl. GPU memory the kernel charges to the process, compressed/swapped excluded). They
  are different quantities and are never added or equated.
- **Observable copies / bytes** (`wk-native*` only, from the host's `GET /__ntgpu/stats` at each mark): wire body
  bytes, command / upload / readback bytes, native reassembly copies, downstream bytes, polls, submissions, submit ms
  per submission and body queue ms per body, per frame. Copies inside WebKit (request bodies, responses) and inside
  Chrome (IPC to its GPU process) are not observable and not claimed.
- **Cache tags**: Chrome run 0 of a mode uses an empty profile (Dawn/Chrome shader + pipeline disk caches cold), later
  runs reuse it (warm). The OS Metal compiler cache (per bundle id / executable) is never cleared; its presence is
  recorded per WK run. wgpu-native keeps no pipeline cache across processes. Startup values are split cold / warm.
- **Power**: `ProcessInfo.isLowPowerModeEnabled` and `thermalState` (not `MTLDevice.isLowPower`), providing power
  source, `pmset -g` / `pmset -g therm`, before and after every run; GPU clients and top CPU processes for 2 s before
  and after each run (contention evidence).

## Validity gates (summarize.mjs)

A run is **clean** only when it finished, the camera stayed on the driver's LIVING view from the first to the last
stats, power source / Low Power Mode / thermal state were AC / off / nominal both before and after, and every other
Metal client (WindowServer excluded) used at most 200 ms/s of GPU time inside the measured phases
(`--contended-ms-per-s`). Medians use clean runs only; every excluded run is listed with its reason. A run spent
entirely on battery with Low Power Mode on is regrouped as `<mode>~observed-battery-lowpower`, never mixed in.
`run.mjs` / `cli-bench.mjs --wait-quiet <ms/s>` wait (at most 10 min) until the other clients are below that before
starting. `--first-index N` continues a mode's run numbering (index 0 is the cold run). `run.mjs --no-activate`
passes the host's `--no-activate` (window ordered back, no key focus).

## Commands

```sh
R=/tmp/nt-native-gpu-measurements-root
swiftc -O -o $R/bin/nt-bench-probe gpu/native/benchmark/probe.swift -framework IOKit
# sandbox: clone of the reactor lane's read-only consumer copy (67ffa0c) + nativetron engine/gpu/ipc of <sha>
cp -cR /tmp/nt-reactor-e2e/hp $R/sandbox/hp; git archive <sha> engine gpu ipc | tar -x -C $R/sandbox/nativetron
# macOS host with the executor linked (+ --benchmark-viewport)
NT_MACOS_BUILD_DIR=$R/app NT_MACOS_WASM_ROOT=<nativetron main> \
  NT_GPU_EXECUTOR_LIBS="<libntgpu-executor.a> <wgpu-native>/lib/libwgpu_native.a -framework Foundation -framework CoreFoundation -lobjc -liconv" \
  hosts/macos/build.sh
node gpu/native/benchmark/measure.mjs --root $R --out $R/runs --app $R/app/Nativetron.app/Contents/MacOS/Nativetron \
  --reactor <nt-reactor> --executor-lib <libntgpu-executor.dylib> --nativetron-commit <sha> \
  --modes ac-high,low-power --runs 3 --cli-runs 3 [--allow-pmset] \
  --corpus-driver <ntgpu-executor-driver> --corpus /tmp/nt-native-gpu-shaders-20261113 --corpus-runs 3
# pieces: build-bundle.mjs, record-bench.mjs, run.mjs --path …, cli-bench.mjs, summarize.mjs (see each file's header)
```

`--quick` (any script) shrinks every count for harness checks; quick output is never a result.
Low Power Mode is entered only with `--allow-pmset` (the parent's authorization): `sudo -n pmset -c powermode 1`
(never a password prompt), verified through `ProcessInfo.isLowPowerModeEnabled`, original AC `powermode` restored in
`finally` and on signals, `pmset -g custom` before/after in `power-evidence.json`.
