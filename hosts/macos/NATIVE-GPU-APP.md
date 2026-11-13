# macOS native GPU app integration

The opt-in macOS path runs the **same engine Worker reactor** (`engine/worker.js` → `engine/reactor.js`, same Wasm)
with its GPU op stream executed by a native WebGPU executor (`gpu/native/executor.h`, wgpu-native/Metal) instead
of WKWebView WebGPU. JS WebGPU stays the default; nothing changes unless the host is started with `--native-gpu`.

## Run

```sh
# one artifact root outside the worktree; prebuilt Wasm read from a read-only tree (no .scriptc written here)
export NT_MACOS_BUILD_DIR=/tmp/nt-gpu-macos-e2e/build NT_MACOS_WASM_ROOT=/path/to/nativetron
# link an executor artifact (else the native path is built against an unlinked stub that never executes)
export NT_GPU_EXECUTOR_LIBS="$EXEC/libntgpu-executor.a $WGPU/lib/libwgpu_native.a -framework Foundation -framework CoreFoundation -lobjc -liconv"
hosts/macos/build.sh
APP=$NT_MACOS_BUILD_DIR/Nativetron.app/Contents/MacOS/Nativetron
$APP --native-gpu                                   # headless execution, no presentation (see Composition)
$APP --native-gpu --native-gpu-composition=overlay  # public API presentation, rect-granular DOM
$APP --native-gpu --native-gpu-composition=underlay-spi   # EXPERIMENTAL, private WebKit SPI
$APP --native-gpu-selftest=wire        # transport proof with the test recorder (no GPU work)
$APP --native-gpu-selftest=e2e         # real reactor + executor; restart and reload phases
$APP --native-gpu-selftest=composition --native-gpu-composition=overlay|underlay-spi   # composited pixels
$APP --native-gpu --url file:///tmp/<dir>/<page>.html     # owner-local read-only content as app://dev
hosts/macos/native-gpu-wire-test.sh    # Swift wire codec checks
node --test engine/native-gpu-wire.test.mjs engine/native-gpu.test.mjs
```

Self-test exit codes: `0` pass (`NT_NATIVE_GPU_SELFTEST_PASS`), `1` fail, `3`
`NT_NATIVE_GPU_SELFTEST_PENDING_EXECUTOR_LINK`: the Worker's frames crossed and `ntgpu_executor_create` was called,
but the build links `native-gpu-executor-unlinked.c`, so nothing executed. Exit 3 is never a pass.
`NT_NATIVE_GPU_CAPTURE_PNG=<file>` saves the composition capture.

## Path

```
page.html ─ claimNativeGpu() ─ POST /__ntgpu/session ────────────────────┐ (once per page load)
engine Worker: reactor.js → native-gpu.js (owned chunks, acks, credits)   │
   → native-gpu-wire.js ─ fetch POST /__ntgpu/post?engine=g&b=n ──┐       │
                        ─ fetch GET  /__ntgpu/poll?engine=g ◀─┐    │       │
MacSchemeRouter (WKURLSchemeHandler, app://) ─ NativeGPUBridge ┴────┴───────┘
   main thread: capability, ordering (b), frames → engine queue (serial per generation)
   engine queue: reassembly → ntgpu_executor_submit → ACK; callbacks only enqueue frames
   NativeGPUSurfaceHost: CAMetalLayer lease → executor metal_layer; plan → resize; display link → ticks
```

- **Selection** is explicit and happens before any canvas or probe: the host injects
  `window.__ntNativeGpuOffer` (document start, main frame) only with `--native-gpu`; the page claims a session and
  passes `{endpoint, session}` to `createEngine`. The Worker probe needs WebAssembly, `fetch` and streams only — no
  `navigator.gpu`, `OffscreenCanvas` or rAF. A refused claim is reported, never silently replaced by WebGPU.
- **Upstream**: every command/upload chunk is its own POST body; the 32-byte frame header (plus any pending control
  frames, e.g. OPEN/SUBMIT) is written into 256 bytes reserved in front of the owned chunk, so the transport adds no
  copy after the single Wasm → owned copy. ≤ 3 bodies in flight; the bridge answers a body only after the
  generation's executor queue consumed it (real backpressure); out-of-order arrival is reordered by `b` (≤ 8).
- **Acknowledgement**: `ACK n` is written only after `ntgpu_executor_submit` returned for submission `n` (the
  executor retains no pointer). Sections that arrived as one chunk are passed straight from the request body;
  multi-chunk sections are copied once into an exact-size buffer (never a max-size arena).
- **Downstream**: one held long-poll per generation, answered with every queued frame (one write + finish) as soon as
  one exists; the Worker re-polls. Readbacks leave the executor callback as ≤ 4 MiB chunks (one copy, the data is
  borrowed) followed by their MAP_READY event; DEVICE_LOST bumps the device epoch stamped on later frames.
- **Frames**: executor `frame_requested` → `FRAME_REQUEST` → the JS host's scheduler sends `TICK_REQUEST` → the
  surface display link (presentation) or a one-shot main-queue turn (headless: ~16.7 ms in `display`, next turn in
  `throughput`) answers with `TICK`. Nothing is armed without a request. JS frame credits (acks) gate frames; the
  surface credit is returned on the next turn.
- **Resize**: the bridge is the single RESIZE source (page geometry headless, surface plan with presentation; every
  new generation first gets the current size, like `gpu/host.js`). Executor RESIZE events are dropped and counted
  (`executorResizeFiltered`).
- **Generations**: a request for engine `g` retires every older generation (executor destroyed on its queue, then
  the CAMetalLayer lease released; the new generation's queue waits ≤ 3 s for the lease). Retired generations get
  410. Navigation (`decidePolicyFor` main frame), content-process termination and window close end the session:
  every generation is closed, held polls are answered 410, WebKit `stop` marks tasks dead.

## Channel investigation (measured on this machine, macOS 27.0.1)

Probe sources: `/tmp/nt-gpu-macos-e2e/probe/{probe,alpha}.swift` (not committed).

| question | result |
| --- | --- |
| Worker `fetch` POST with `ArrayBuffer` body to a `WKURLSchemeHandler` | works: `request.httpBody` holds the exact bytes (16 B, 64 KiB, 4 MiB, 16 MiB checked), `httpBodyStream` nil, custom headers present |
| `stop(task)` on `AbortController.abort()` / navigation | called |
| Long-lived streamed response (`didReceive` repeatedly, no finish) | **unreliable**: a write that follows another write within a few ms (same turn or next main-queue turn) is withheld until a later write arrives (3×100 B → 100 B delivered; 24×256 KiB → 4 MiB delivered); 5 ms spacing delivers. Not used. |
| Long-poll (one write + finish per response) | reliable; 0.25 ms mean round trip for 100 B and 64 KiB, 1.35 ms for 6 MiB (Worker, sequential) |

Hence no loopback HTTP server: the scheme handler is same-origin with the page, needs no listening socket, no
ATS/CSP/CORS change and no exception in the offline content rule list.

## Trust boundary

- Capability: 32 random bytes (`SecRandomCopyBytes`) per navigation, issued once to `POST session` from the page's
  own origin (second claim → 409), required as `X-NT-GPU-Session` on every other route (401 otherwise). Requests
  whose URL is not the current page origin, or that carry a foreign `Origin`, get 403. No CORS headers are sent.
- Bounds: body ≤ 4 MiB + 64 KiB, control payload ≤ 4 KiB, reorder ≤ 8 bodies, one held poll per generation,
  ≤ 2 live generations, downstream queue ≤ 96 MiB (exceeding fails the generation), OPEN limits ≤ the guest's
  (16 MiB commands, 512 MiB uploads, 16 MiB readbacks, chunk 4 KiB…4 MiB), strict sequence/chunk/section order.
- `--url` accepts only `file://` `.html` under `/tmp`, in a directory owned by the user and not group/world
  writable; files are served read-only as `app://dev/…` (symlinks may not leave the directory, GET/HEAD only,
  ≤ 256 MiB). `app://dev` is a different origin from `app://local`: the host-services broker (`ntHost`) and the
  engine bridge (`ntEngine`) keep refusing it; only console evidence and the native GPU endpoint (with
  `--native-gpu`) are available. Remote URLs and paths outside `/tmp` are refused at startup (exit 2). Checked:
  claim 200, second claim 409, `/../../etc/passwd` 404, world-writable dir / https / non-tmp refused.

## Composition (measured with own-window capture, no Screen Recording permission needed)

| WKWebView setting (page `html, body {background: transparent}`) | `takeSnapshot` alpha in clear area | window pixels over a native layer below |
| --- | --- | --- |
| default | 1.0 (white) | white |
| `underPageBackgroundColor = .clear` (public) | 1.0 (white) | white |
| KVC `drawsBackground = false` (**private SPI**) | 0.0 | native layer visible, 50 % rounded DOM blends |

No public macOS API made the web view transparent. Therefore:

- `--native-gpu` alone runs the executor **headless** and logs `NT_MACOS_NATIVE_GPU_PRESENTATION_BLOCKED`.
- `--native-gpu-composition=overlay` (public): native layer above the web view, masked by page-reported exclusion
  rects. Measured: a translucent rounded DOM box over the canvas is **covered by the scene** (raw sample equals the
  scene); unreported DOM over the canvas is invisible and reported DOM cannot blend. Logged as
  `NT_MACOS_NATIVE_GPU_COMPOSITION`.
- `--native-gpu-composition=underlay-spi` (**experimental, quarantined**): uses the private SPI and logs
  `NT_MACOS_NATIVE_GPU_POLICY_BLOCKER`. Measured: the same box blends over the scene within 0.001 of the
  calibrated 50 % model (`halfRedOverScene` ≈ `(opaqueRedDom + scene)/2`). Not shippable while it needs SPI.
- Both modes measured the surface aligned to the canvas (CSS 16,156.19 640×400 → view 16,156 640×400 at 2×).
  Colour-space match (sRGB vs P3) and EDR are not verified beyond these raw samples.

## Instrumentation (no timing claims; for later parent runs)

- JS (`wire.stats`): `bodies`, `bodyBytes`, `zeroCopyChunks`, `copiedChunks`, `transportCopiedBytes` (control frames
  only), `peakInflight`, `postMs/postMaxMs`, `polls`, `pollBytes`, `acks`, `ackMs/ackMaxMs` (SUBMIT queued → ACK),
  `readbackBytes`, `readbackCopiedBytes`, `ticks`, `tickMs/tickMaxMs`; core `stats.copiedBytes` (Wasm → owned).
- Native (`GET /__ntgpu/stats`, self-test output): `bodies`, `bodyBytes`, `maxBodyBytes`, `bodyQueueMs/MaxMs`,
  `submissions`, `submitMs/submitMaxMs`, `commandBytes`, `uploadBytes`, `zeroCopySections`, `reassemblyCopies/Bytes`,
  `acks`, `downBytes/downWrites/downMaxWrite`, `polls`, `readbacks/readbackBytes/readbackCopyBytes`, `events`,
  `ticks/tickMs`, `executorCreateMs`, `executorResizeFiltered`, `deviceLost`, `engineFailures`, `leaseWaitTimeouts`.
- Copies per upload byte: 1 (Wasm → owned, JS) + WebKit's request-body handling (not observable here) + 0 or 1
  native (0 for a single-chunk section). Per readback byte: 1 native (borrowed callback data) + WebKit's response
  handling + 1 JS (poll answer → owned) + the guest's `readback` export copy.

## Self-test evidence (this lane)

- `--native-gpu-selftest=wire` (recording executor, executes nothing): byte-exact commands/uploads (FNV-1a, incl.
  9 MiB + 3 uploads in 3 chunks with 2 natively reassembled), a 6 MiB readback in two chunks, executor frame request
  → native tick → frame callback, DEVICE_LOST epoch advance, acks only after consumption, zero transport copies,
  generation 2 retiring generation 1 (410), wrong capability (401).
- `--native-gpu-selftest=e2e` linked against `libntgpu-executor.a` built by `gpu/native/build-executor.sh` from the
  executor lane's commit `9c80453` (branch `fleet-mode/20261113-162048-session/gpu-executor-integrated`, not yet on
  this branch) plus pinned `libwgpu_native.a` v29.0.1.1: `engine/page.html` → demo reactor in the Worker →
  wgpu-native: CAPABILITIES, pipelines, compute + render, 16 MiB upload in 4 chunks, guest-verified
  `GPU_READBACK_OK 4096`; then `lane.restart()` (generation 2 executes and reads back; generation 1 executor
  destroyed) and a page reload (new session, old executor destroyed, new one reads back). Native counters for the
  run: 8 submissions / 8 acks, 33,554,432 upload bytes (8 multi-chunk sections reassembled, 8 single-chunk
  sections passed without copy), 4 readbacks (8,224 bytes), 2 executors created, executor RESIZE events filtered 3.
- `--native-gpu-selftest=composition` (same build) passes for `overlay` and `underlay-spi` with the samples above.
- Unlinked build: e2e exits 3 with `ENGINE_FAILED … native GPU executor pending link` in the page.
- Idle: with the demo idle, the WebContent process accumulated no CPU time over 10 s.

## Open items

- The executor is linked through `NT_GPU_EXECUTOR_LIBS` until its artifact is on this branch; re-run the three
  self-tests after merging the executor lane.
- Presentation fallback (`.presentation(_, fallback:)`) is logged only; switching an executing generation back to
  WebGPU is not implemented. Transparent composition needs private SPI on macOS (see above).
- Frame credit uses JS acknowledgement (executor consumption), not GPU completion; the executor C API has no
  per-frame completion callback.
- No packaging/signing, no GPU timings (deferred until other agents finish).
