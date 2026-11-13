# Native GPU spike: measurements (deliverable 6) and go/no-go (deliverable 7)

Measured 2026-11-13, 18:03–20:33 UTC. Machine: Apple M4 Max (16 cores, 128 GB), macOS 27.0.1 (26A434), built-in
display at backing scale 2. The house-planner app ran with its full UI on the Bresso scene, at canvas 1600×1520,
desktop tier, deterministic GI rays. The runs used nativetron `598d7b0` ("frame credits follow real GPU completion")
and consumer `67ffa0c` (the commit the canonical engine Wasm and native dylib were built from). Method and counters:
[`README.md`](README.md). Raw data: `/tmp/nt-native-gpu-measurements-root` (see the end).

## Verdict

**No-go for making the native executor the default macOS GPU path. Go only for keeping it as an explicit, opt-in
experimental path.** The reasons are measured:

1. **Slower than Chrome's JS WebGPU on the same frames.** Each frame is rendered back to back and waits for its GPU
   completion.
   - Moving camera: 21.2 ms vs 15.2 ms per frame (+39 %).
   - Still camera: 8.1 ms vs 3.9 ms per frame (+107 %).
2. **The GPU work itself is the main cause, not the WKWebView crossing.**
   - Kernel-accounted GPU time per frame: 15.9 vs 12.0 ms moving, 4.8 vs 2.9 ms still. That is wgpu-native/Metal
     against Dawn/Metal on identical engine input.
   - The best-case CLI path, with the same executor and no WebView, is no faster: 21.3 ms moving, 6.1 ms still.
   - Compared with that CLI path, the crossing costs about 2 ms per GPU-completed round trip on still frames and
     nothing measurable on moving frames.
3. **Presentation is not shippable.**
   - With public API (overlay), DOM cannot blend over the scene; transparency needs private SPI (macOS app lane).
   - With overlay presentation, **2 of 16 runs never produced a first frame within 20 min**. In both, the host
     reported `NT_MACOS_NATIVE_GPU_PRESENTATION visible=false`: the window was not on a visible workspace. The engine
     stalls with no headless fallback.
   - In 3 of 16 overlay runs (0 of 14 headless, 0 of 14 Chrome) the camera left the driver's view; the cause was not
     isolated.
4. **Where native does better:**
   - About 150 MB less physical footprint: 713 MB across the app's processes vs 863 MB for Chrome's.
   - The same first-image time with warm caches: 553 ms vs 522 ms.
   - Both paths idle at zero engine frames.
   - The image matches Chrome's: 0 % of thumbnail pixels over the 12/255 rule on every clean run.

A default switch would need, at minimum, three things:

- closing the executor's GPU-time gap (profile wgpu-native's Metal passes against Dawn for the `lighting`, `glass`
  and `reflect` work);
- a hidden-surface fallback that keeps the engine progressing;
- composition that needs no private SPI.

None of these is a measurement artifact. The table below supports each one.

## Results (AC power, High Power energy mode, Low Power Mode off, thermal nominal; clean runs, medians)

A run counts as **clean** only when all of these hold; the other runs are kept and listed under Exclusions:

- it finished;
- the camera stayed on the driver's view;
- power source, Low Power Mode and thermal state were AC / off / nominal both before and after the run;
- other Metal clients used ≤ 200 ms/s of GPU time inside the measured phases (WindowServer excluded; the user's
  resident Slack and terminal used 60–140 ms/s throughout).

| path | clean / runs | still ms/frame (range) | moving ms/frame (range) | CPU ms/frame still · moving | kernel GPU ms/frame still · moving | GPU timestamp frame span ms (moving) |
| --- | --- | --- | --- | --- | --- | --- |
| `chrome` (Dawn, JS WebGPU, headed) | 7 / 13 | **3.92** (3.71–4.22) | **15.23** (14.69–16.87) | 1.47 · 4.30 | 2.88 · 12.00 | 14.09 |
| `wk-native` (WK → wire → executor, headless) | 7 / 14 | **8.10** (5.70–9.30) | **21.20** (21.00–21.90) | 2.55 · 4.85 | 4.79 · 15.85 | 18.43 |
| `wk-native-overlay` (+ CAMetalLayer overlay) | 3 / 15 | **8.40** (8.40–9.40) | **21.70** (21.70–26.00) | 2.98 · 5.85 | 5.41 · 15.33 | 18.32 |
| `cli-native` (nt-reactor, native engine dylib) | 6 / 12 | 6.13 (5.99–6.25) | 21.32 (21.20–21.55) | 0.83 · 2.42 | 4.52 · 18.52 † | — |
| `cli-wasm` (nt-reactor, same Wasm in Node/V8) | 5 / 12 | 6.16 (5.99–6.26) | 21.45 (21.35–21.54) | 1.06 · 3.09 | 4.65 · 18.65 † | — |

Each run contributes 5 still samples and 6 moving samples of 10 frames each, after 5 warm-up frames.

- **ms/frame** = 1000 / (back-to-back GPU-completed frames per second); it is not a display frame rate.
- **CPU** = user + system time of every process of the launch, per frame.
- **Kernel GPU** = `AGXDeviceUserClient` `accumulatedGPUTime` of those processes, per frame.
- **†** The CLI samples the processes at 20 Hz rather than at the driver's marks, so its per-frame GPU time is coarse;
  compare its wall time.
- **GPU timestamps** are the engine's own pass spans. They are not busy time: a 3.9 ms Chrome still frame spans 14.3 ms.
  Per-pass splits are not comparable across implementations: wgpu-native reports `lighting` ≈ `glass` ≈ 15.6 ms and
  `tonemap` 0, which are overlapping encoder-boundary samples on a TBDR GPU.
- **CLI is the best-case headless number** for this engine on this executor. It is never the app path:
  - frame-synchronous replay with a lockstep pump;
  - 13 frame-sync divergences per replay, where the engine went idle earlier than the page's frame count;
  - no page, no wire, no presentation.

**Where the CPU goes** (clean-run medians, ms per frame, still · moving):

- Chrome: GPU process and helpers 0.92 · 2.38, renderer (page and engine Worker) 0.54 · 1.91, browser ≈ 0.
- `wk-native`: the Nativetron process (bridge and executor) 1.52 · 3.11, WebContent (page and Worker) 1.04 · 1.79,
  WebKit GPU process ≈ 0.
- `cli-wasm` costs 0.2–0.7 ms of CPU per frame more than `cli-native` (V8 against native code) at the same wall time.

### Startup, first image, shader and pipeline caches

| path | first image ms | first GI convergence ms | cache state |
| --- | --- | --- | --- |
| `chrome` | 525.8 (run 0) · 522.3 (warm median) | 1205.6 · 1150.3 | run 0: empty profile (Dawn/Chrome disk caches cold); OS Metal cache for Chrome's helper shared with the user's Chrome and not cleared |
| `wk-native` | 553 (warm median) | 1516 | app's Metal cache (`dev.nativetron.macos`) present |
| `wk-native`, app Metal cache moved aside | **6274** (1 run) · 563 (next run) | 9927 · 1521 | cold: the executor's largest single submit took **5709 ms** and the 46 startup submits 8532 ms, against 42 ms and 128 ms warm. This run's later phases were contended, but its startup was not |
| `wk-native-overlay` | 567 (warm median) | 1598 | as `wk-native` |

First image is the app's own `startup.firstFrame`: an engine status with the scene, then one more rendered frame.
Page times are measured from navigation.

- **Pipeline-compile cost.** The executor creates pipelines synchronously inside its submit, so the cold-cache
  startup submit is a pipeline-compile bound: about 5.7 s, against Chrome's asynchronous creation, which is not
  observable from the page.
- **Host launch.** Process launch to page bootstrap is 353 ms for the macOS host. Chrome's 21 ms is only
  `page.goto` after the browser was already up.
- **Shader corpus through the executor** (`executor-corpus.mjs`: 199 modules, 810 pipelines, Naga → MSL → Metal):
  615 / 632 / 615 ms per process with all 810 pipelines OK, 0 uncaught errors and 0 device losses. The system Metal
  cache was warm; it is shared by non-bundled executables, so a cold run would mean clearing a cache other
  applications use, and was not done.
  - **Chrome:** no equivalent isolated compile time was measured.

### Memory (tracked allocation ≠ physical residency)

- **Engine-tracked allocations:** 346 MB on every path, from the engine's own estimate (GI 166 + direct 18 +
  reflections 28 + targets 134).
- **Physical footprint** (`phys_footprint`) at the end of the idle window, per process class:

| path | process class | footprint |
| --- | --- | --- |
| Chrome | GPU process + other helpers | 546 MB |
| Chrome | renderer | 232 MB |
| Chrome | browser | 85 MB |
| Chrome | **total** | **863 MB** |
| `wk-native` | Nativetron (executor and Metal resources) | 452 MB |
| `wk-native` | WebContent | 237 MB |
| `wk-native` | WebKit GPU | 18 MB |
| `wk-native` | other | 6 MB |
| `wk-native` | **total** | **713 MB** |
| overlay | Nativetron | 474 MB |

- **CLI:** peak footprint is 1124 MB for `cli-native` and 1244 MB for `cli-wasm` (nt-reactor plus the Node guest).
  These peaks include the reactor's capture buffers, so they are not comparable with the table.

### Observable copies and bytes (`wk-native`, from `GET /__ntgpu/stats`, per frame)

| | still | moving |
| --- | --- | --- |
| submissions | 1 | 1 |
| wire request bodies | 4.09 KB (commands 3.10 KB, uploads 0.90 KB) | 10.89 KB (commands 6.96 KB, uploads 3.80 KB) |
| bodies with no native copy | 0 B reassembly copies (every section single-chunk) | same |
| readback (native copy out of borrowed executor data) | 20 B | 1.36 KB |
| downstream | 172 B | 1.61 KB |
| long-polls | 2.07 | 3.25 |
| executor submit per submission | 0.37 ms | 0.73 ms |
| body queue | 0.20 ms | 0.26 ms |

- **Wasm → owned chunk:** 1 copy in JS (`stats.copiedBytes`, not sampled by this harness).
- **Not observable:** copies inside WebKit (request bodies, responses) and inside Chrome (IPC to its GPU process).
  They are not claimed.

### Idle after settle (10 s window)

- **Engine frames:** 0 on every path.
- **CPU:**
  - Chrome 0.33 ms/s (1.6 wakeups/s).
  - `wk-native` 0.85 ms/s (4.0 wakeups/s; WebContent 0.48, Nativetron 0.19).
  - overlay 0.70 ms/s.
- **Kernel GPU time:** 0 ms/s for all.

**Settle never happened.** The engine's `STATUS_SETTLED` never arrived in the full app on any path: the direct light
stays `pending`. That is the consumer's behaviour, also in Chrome. The procedure therefore continues after a bounded
20 s wait, and `hpPresent.still` would only measure its own 60 s timeout.

### Image check

On every clean app run (LIVING view, `runGi(64)`, `capture()`, 16×16 box thumbnail, golden rule): 0 % of pixels over
12/255, max channel delta ≤ 5, against Chrome (20 clean app runs, each compared with Chrome run 0, or with run 1
for run 0 itself). The camera runs show why the camera is also checked directly: overlay #0 failed the check at
99.6 %, but #1 and #4, moved to nearby views, differed in only 0.02 %.

## Low Power Mode

**The controlled bracket is blocked.** The gate authorized `sudo -n /usr/bin/pmset -c powermode 1` and restoration.
Both attempts (18:18:01Z and 19:23:46Z) returned `sudo: a password is required` (exit 1), so the harness entered no
low-power runs, prompted for no password and changed no setting.

**Restoration evidence.** The original was AC `powermode 2`, `isLowPowerModeEnabled=false`. Afterwards, `pmset -g
custom` was byte-identical to before (`power-evidence*.json`, `customIdentical: true`). Unblocking it takes a
non-interactive pmset privilege for the measuring process, which only the machine's owner can grant.

**Observed, not controlled.** Between 19:25Z and 19:33Z the machine's user unplugged the charger, so the source
became Battery Power and battery `powermode 1` set `isLowPowerModeEnabled=true`:

- **Chrome:** one clean run happened entirely in that state. Still 5.57 ms and moving 24.35 ms per frame (+42 % and
  +60 % against AC); kernel GPU 4.69 · 20.37 ms; first image 856 ms. n = 1, not a measurement of record.
- **Native:** no native run in that window was clean. One overlay run was contended; one headless run changed state
  mid-run.

These runs are grouped as `ac-high~observed-battery-lowpower` and never mixed into the AC numbers.

## Exclusions and contention (all raw runs kept)

**The machine was not uncontended.** A different pi session (pid 79469, house-planner worktrees under
`…/development/.pi-worktrees/20261103-001946-session-*`, not this task's parent) ran the following during the window:

- `scripts/gates.mjs`: tsc, eslint, vitest, drawings, goldens-raster, ui-smoke, lowend-smoke;
- QCAD;
- `scripts/nav-bench.mjs`;
- repeated headless Chrome GPU processes: `Google Chrome Helper`, 170–840 ms/s of GPU time.

This harness did not stop them. Instead it does three things:

- **Waits for quiet before a run:** `--wait-quiet 150` before each later run.
- **Measures every other Metal client** at every mark (`gpu_all` and names) and excludes phases above 200 ms/s.
- **Applies the power and camera rules** above.

**Excluded runs, by reason:**

| reason | `chrome` | `wk-native` | `wk-native-overlay` | CLI |
| --- | --- | --- | --- | --- |
| other GPU clients 253–731 ms/s | 6 (#1, #6, #9, #11, #13, #14) | 4 (#0, #3, #7, #9) | 6 (#3, #5, #8, #11, #12, #15) | 5 runs (native #6, #7; wasm #6, #7, #9) |
| camera left the view | — | — | 3 (#0, #1, #4) | — |
| no first frame, `presentation visible=false`, 20 min timeout | — | — | 2 (#7, #13) | — |
| power or thermal state changed inside the run | — | 3 (#10, #11 battery transitions; #14 thermal `fair`) | 1 (#14 thermal `fair`) | — |
| entirely on battery with Low Power Mode on (regrouped as observed) | 1 (#10, clean) | — | 1 (#10, contended) | — |
| contention not recorded (first session) | — | — | — | 8 runs (#0–#3 of each guest) |

- **Activation.** The diagnostic `--no-activate` overlay runs (`diag-noactivate`, n = 1 clean) had no camera
  contamination, but moving was slower at 25.9 ms. They are not mixed in.
- **Run order.** Runs were interleaved across paths (run i of every path before run i + 1).
- **Thermal state** was `nominal` throughout, except the two transitions involving `fair` in the `#14` runs, which are
  excluded.

## Excluded path: WKWebView WebGPU

`wk-webgpu` runs, but it is not a baseline. WebKit fails to compile the engine's shaders
(`Failed to compile the shader source, generated metal …`) and then reports `encoder state is not valid` every
frame. The gpu-shaders lane traced this to WebKit's CAS prelude. A WKWebView app on this OS therefore cannot use the
engine through WebKit WebGPU at all: the native executor path is the only working GPU path inside WKWebView here.

## Scope, binary, CI and fallback

**Measured on:**

- macOS 27.0.1 / Apple M4 Max only, on AC in High Power energy mode, plus the observed battery and Low Power Mode
  anecdote above;
- one display scale (2), one canvas size (1600×1520) and the desktop tier;
- the Bresso scene.

**Not measured:**

- other Apple GPUs (M1/M2/M3, base and Pro variants);
- Intel Macs;
- iOS (simulator and emulator expose no WebGPU adapter, and the executor was not run on a device);
- Android, Windows and Linux (executor built for macOS only);
- other tiers, scenes and window sizes;
- display frame pacing (no presentation counter is common to all paths).

**Binary:**

- The macOS host grows from 0.93 MB to 12.69 MB (arm64, unstripped) when the executor and the patched wgpu-native
  are statically linked.
- `libntgpu-executor.dylib` is 11.6 MB; the static `libwgpu_native.a` is 36.6 MB.
- No signing or notarization was done.

**CI:**

- The build needs the patched wgpu-native build (`v29.0.1.1+naga-wgsl-compat.1`, a Rust toolchain and a cache).
  The unpatched build fails the `gi.insert` / `gi.merge` pipelines, and wgpu then aborts the process.
- Every number here needs a real Metal GPU and a logged-in session: the app opens a window, and the WK paths need
  a visible window for overlay presentation. Hosted macOS runners were not validated.
- The harness is reproducible with one command (below). Its contention, camera and power gates make it usable on a
  shared machine only with the exclusions reported.

**Fallback:**

- JS WebGPU stays the default. The native path needs `--native-gpu`, and the page claims it explicitly.
- No runtime fallback exists. A hidden or invisible overlay surface stalls the engine (measured), and an executor
  abort takes down the host (executor lane).
- WebKit's own WebGPU is not a fallback on this OS: it fails the engine's shaders.
- Chrome or another browser engine (Dawn) is the only measured path that is both correct and faster here.

## Commands

```sh
R=/tmp/nt-native-gpu-measurements-root
# app with the executor linked (final main 598d7b0 merged; adds --benchmark-viewport)
NT_MACOS_BUILD_DIR=$R/app NT_MACOS_WASM_ROOT=/Users/thundron/Documents/development/axelerontech/nativetron \
  NT_GPU_EXECUTOR_LIBS="/tmp/nt-native-gpu-final/executor/libntgpu-executor.a /tmp/nt-native-gpu-deps/wgpu-native/v29.0.1.1+naga-wgsl-compat.1/macos-aarch64-release/lib/libwgpu_native.a -framework Foundation -framework CoreFoundation -lobjc -liconv" \
  hosts/macos/build.sh     # then: Nativetron --native-gpu-selftest=e2e → NT_NATIVE_GPU_SELFTEST_PASS (provenance/app-selftest-e2e.log)
COMMON="--root $R --out $R/runs --app $R/app/Nativetron.app/Contents/MacOS/Nativetron --reactor /tmp/nt-native-gpu-final/reactor/nt-reactor \
  --executor-lib /tmp/nt-native-gpu-final/reactor/libntgpu-executor.dylib --nativetron-commit 598d7b038c1a71bcccee6d996ac3c2c141e13df6"
node gpu/native/benchmark/measure.mjs $COMMON --modes ac-high,low-power --runs 4 --cli-runs 4 --allow-pmset \
  --corpus-driver /tmp/nt-native-gpu-final/executor/ntgpu-executor-driver --corpus /tmp/nt-native-gpu-shaders-20261113 --corpus-runs 3
node gpu/native/benchmark/measure.mjs $COMMON --modes ac-high,low-power --runs 4 --first-index 6 --cli-runs 4 --allow-pmset --wait-quiet 150
node gpu/native/benchmark/measure.mjs $COMMON --modes ac-high --runs 3 --first-index 10 --cli-runs 4 --wait-quiet 150
node gpu/native/benchmark/measure.mjs $COMMON --modes ac-high --paths wk-native-overlay,wk-native,chrome --runs 3 --first-index 13 --cli-runs 0 --wait-quiet 150
node gpu/native/benchmark/run.mjs --root $R --out $R/runs/diag-noactivate/app --path wk-native-overlay --runs 2 --first-index 1 --no-activate --app …
# cold app Metal cache: move $(getconf DARWIN_USER_CACHE_DIR)dev.nativetron.macos/com.apple.{metal,metalfe,gpuarchiver} aside,
node gpu/native/benchmark/run.mjs --root $R --out $R/runs/metal-cold/app --path wk-native --runs 2 --wait-quiet 150 --app …
#   then delete the regenerated cache and move the originals back (provenance/metal-cache-*.txt: 7940 KB before = after)
node gpu/native/benchmark/summarize.mjs --runs $R/runs
```

## Artifacts (`/tmp/nt-native-gpu-measurements-root`)

**Results:**

- `runs/summary.md` and `runs/summary.json`: per-path medians, exclusions, and every derived row.
- `runs/results.csv`: one row per run, raw values.
- `runs/<mode>/app/<path>-NN.json`: raw app runs. Each holds the driver's output, every probe sample per mark
  (CPU, GPU and footprint per pid, plus all Metal clients), native stats per mark, power state before and after,
  contention before and after, host lines, and cache state.
- `runs/ac-high/cli/<guest>-NN.json` and `<guest>-NN/`: raw CLI runs (timepoints, `run.json`, engine log, 20 Hz
  samples) and the compiled scenario.
- `runs/ac-high/corpus/`: executor shader-corpus reports and timing.

**Power and session logs:**

- `runs/environment*.json`, `runs/power-evidence*.json`, `runs/status*.json`, `runs/measure.log`.
- `runs-console*.log`.
- `gate.json`: the parent's gate.

**Inputs and provenance:**

- `recordings/bench/`: the recorded input of the CLI replay.
- `bundle/`: the served app.
- `provenance/`:
  - `bundle.json`: sha256 of every served file, with the nativetron and consumer commits;
  - `house-planner.head`, `nativetron.commit`;
  - the app's e2e self-test log;
  - Metal cache sizes;
  - `pmset -g custom` from before the session.
- `app/Nativetron.app`: the measured host binary.
- `bin/nt-bench-probe`.

**Binary checksums (sha256):**

| binary | sha256 |
| --- | --- |
| `Nativetron` | `9b5b9d7d…6e28` |
| `libntgpu-executor.dylib` | `26a865fc…0519` |
| `nt-reactor` | `02827fd4…3dff` |
