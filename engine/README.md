# In-page engine lane

The engine is a second wasm reactor inside the page, not a native process. Native retains windows, menus, dialogs and files. GPU batches and uploads remain in reactor memory; only bounded control messages cross the native bridge.

```sh
engine/build.sh
NT_ENGINE_SELFTEST=1 ./build/engine-desktop
node --test ipc/engine.test.mjs
node engine/browser-test.mjs
node --test engine/lifecycle.test.mjs   # lifecycle, routing, queues, shutdown (fake worker/GPU doubles)
node engine/lifecycle.browser-test.mjs  # real Chrome WebGPU restart, device loss, post-transfer failure, recovery
```

`engine/lifecycle.html` and `engine/fixtures/` are test-only; `engine/package.mjs` does not stage them, and the runtime remains `host.js`, `worker.js` and `reactor.js`.

`engine/build.sh --web` builds the two reactors and stages the offline bundle without building the desktop executable. Serve the repository root and open `/engine/page.html`; `?main` explicitly exercises the main-thread fallback.

## Loader API

`startEngine({ canvas, moduleUrl, wasmUrl, prefix, report, postNative, postUi, onEvent, forceMain? })` returns a promise of a lane `{ mode, reason, send(bytes, source?), dispose(), reactor }`. `mode` is `worker` or `main`. `reactor` is available only in main mode; applications must not depend on it. `send` validates the generated IPC frame and bounds control traffic to 60 messages/second. Source defaults to UI; native ingress must specify NATIVE. `dispose` stops scheduling and releases GPU resources. If startup fails, the promise rejects with an `EngineError` and everything the attempt created is released.

The loader probes WebGPU, device creation, OffscreenCanvas context configuration and worker rAF, then has the worker import the module, fetch the wasm, validate it and check the prefixed `start`/`frame`/`event`/`message` and `memory` exports, all before transferring the real canvas. A failed probe or preparation falls back to main; main performs the same validation before it touches the canvas. Main-thread resize uses the GPU host's observer; worker resize and DPR changes are forwarded from the page without a polling loop. Coalesced window-resize checks cover display changes as well as the resolution media query. OffscreenCanvas dimensions are already physical pixels; they are never multiplied by DPR a second time.

### Lifecycle (additive)

`createEngine(options)` returns the lane synchronously; `startEngine` is `createEngine` plus `await lane.ready`. Additional options and members:

| option / member | behaviour |
|---|---|
| `signal` | `AbortSignal`. Aborting before or during startup rejects `ready` with `name: "AbortError"`, `code: "aborted"` and `canvasTransferred`; abort after startup disposes the lane. |
| `onLifecycle(event)` | `{ state, previous, mode, reason, generation, code?, message? }`, always delivered on a later microtask. |
| `canvasRecovery` | `"none"` (default), `"replace"`, or `(transferredCanvas) => HTMLCanvasElement`. See below. |
| `timeouts` | `{ probeMs: 5000, prepareMs: 15000, startMs: 15000, shutdownMs: 1000 }` overrides. |
| `clock` | `{ now, setTimeout, clearTimeout }` test hook for rate windows and timeouts. |
| `state` | `starting`, `ready`, `lost` (GPU device lost; control still accepted; restart recommended), `failed` (instance discarded; restart required), `restarting`, `disposing`, `disposed`. |
| `ready` | resolves with the lane or rejects with an `EngineError`. |
| `trySend(bytes, source?)` | same checks as `send`, returns `{ ok, queued }` or `{ ok: false, code, message, error }`. It never throws and never calls back synchronously, so a reactor import (for example the UI's `uiToEngine`) can use it without an exception escaping into that instance. |
| `restart({ reason }?)` | resolves (never rejects) with `{ ok: true, mode, reason, generation, canvas }` or `{ ok: false, code, message, mode, generation, canvasTransferred, workerAlive }`. Concurrent calls share one attempt; it refuses `starting` and `disposed` lanes. |
| `dispose()` | idempotent; returns a promise of `{ graceful, reason, mode }`. |
| `generation`, `canvas`, `gpu`, `failure`, `stats` | current instance number, current canvas (after a replacement), last capability, last failure, routing/queue counters. |

Error codes include `invalid-options`, `module-load-failed`, `module-invalid`, `wasm-load-failed`, `wasm-invalid`, `wasm-exports-missing`, `instantiate-failed`, `start-failed`, `start-failed-after-transfer`, `start-timeout`, `restart-timeout`, `canvas-lost`, `engine-failed`, `engine-panic`, `invalid-route`, `worker-error`, `queue-full`, `rate-limited`, `disposed` and `aborted`.

**Instances.** Every start and restart creates a new wasm instance with a new GPU host, device and handle table; a failed instance is never re-entered. A trap, panic (`scriptc.panic`) or exception escaping an export or host import discards the instance and its GPU host immediately and moves the lane to `failed`. Restart in worker mode keeps the worker and its OffscreenCanvas, disposes the old instance (unconfiguring the context and destroying the device), and instantiates the already-validated bytes again. Worker messages carry the generation; anything from an older generation is dropped, so a late `ready`, `failed`, credit or routed frame can never complete or corrupt the current one. Control frames in flight to a discarded generation are dropped; frames sent while `restarting` are queued.

**Canvas transfer.** Once the canvas has been transferred it cannot be used by the page again. If the worker then fails to start, or later stops responding, the default is a precise result: `ready` rejects with `start-failed-after-transfer` and `canvasTransferred: true`, or `restart` returns `restart-timeout` and then `canvas-lost`. `ENGINE_ERROR` is reported and `ENGINE_MODE` is not. With `canvasRecovery: "replace"` the loader creates a canvas with the same attributes, puts it where the transferred canvas was (`ENGINE_CANVAS_REPLACED`), and starts on it: main mode after a start failure, or the full probe sequence after an unresponsive worker. `lane.canvas` and `lane.reason` report the change. A function strategy supplies the replacement element instead.

**Routing and bounds.** Inbound reliable control frames (UI/native → engine) are checked for version, lane and length, limited to 60 per sliding second (one window shared by UI and native sources), and bounded at 32 while starting/restarting and 64 unconsumed frames after that (worker credits or the main-thread inbox). Outbound frames (engine → UI/native), including `gpuReport` reports, are validated and rate-shaped by the engine instance to 60 per sliding second, with up to 64 waiting frames. Overflow drops frames and reports `ENGINE_ROUTE_DROPPED` at most once per second. Reports longer than the payload bound are truncated. The page side validates every routed frame again (`ENGINE_ROUTE_REJECTED`), and an exception from `postNative`/`postUi`/`onEvent` is reported, never propagated into the engine. Because shaping happens in each instance, a restart starts a new outbound window.

**Reentry.** Inbound frames, resize and GPU events are queued and delivered from a later microtask while no export of that instance is running. An export called while another is active is rejected. Through the loader, no call into one reactor runs synchronously inside another reactor's import.

**Shutdown.** Worker `dispose` sends `stop`; the worker disposes the instance, acknowledges with `stopped` and closes itself. Without an acknowledgement within `shutdownMs`, the loader calls `terminate()`, resolves `{ graceful: false }` and reports `ENGINE_SHUTDOWN_FORCED`. Viewport observers, media and window listeners, rAF callbacks, rate timers and abort listeners are removed on dispose; restarts reuse the single watcher.

The reactor exports `${prefix}start()`, `${prefix}frame(timeMs)`, `${prefix}event(type, requestId, handle, status, value, text)` and `${prefix}message(topic, bytes)`. Its host callbacks are `gpuPresent(batch, uploads, readbacks)`, `gpuReport(text)` and optional `engineSend(frameBytes)`. Capability text is the complete JSON capability object; shader text is the compilation-message array; resize text contains physical width/height, and value contains DPR. No promises, timers or browser objects enter compiled source. Outbound engine messages/reports and GPU events are delivered on later microtasks so a reply cannot reenter an active reactor callback.

The demo UI is independently compiled from `engine/ui.ts` and uses framework signals/components and the DOM Host ABI. UI commands reach the engine in-page (Worker postMessage or a direct reactor call); reports update the UI without native routing. The desktop native menu separately sends the same generated binary protocol through a base64-only fixed eval call. Its automated test invokes a real NSMenu item and waits for GPU submission completion after the colour change.

## Offline assets

`engine/package.mjs` stages an explicit allowlist under `build/engine-assets`; it never serves the repository or its `.git` directory. On macOS, an opt-in webview configuration hook installs `WKURLSchemeHandler` before WKWebView construction. It serves `app://local`, resolves symlinks, rejects paths outside the bundle, and supplies JavaScript/wasm MIME types. COOP/COEP response headers are optional; their presence does not guarantee that a custom origin becomes cross-origin isolated on every webview. Ordinary desktop builds keep their existing about:blank document and do not link the asset handler.

See [engine IPC](../ipc/README.md#engine-channel) for the exact generated description and codec.

## Verification

| host | evidence |
|---|---|
| Chrome, macOS arm64 | Worker preferred and forced-main fallback; compute/readback, compiled UI colour change and DPR=2 physical resize pass |
| WKWebView, macOS 27.0.1 | Worker selected; 16 MiB upload, 4 KiB checked readback, timestamp and actual native-menu colour change pass |
| Chrome, macOS arm64 (lifecycle) | worker and main restart ×3 with fresh device/handles and readback, device loss → restart, post-transfer trap rejected precisely, owned-canvas recovery, probe-phase abort, five mount/dispose cycles |
| WKWebView, macOS 26 | not available on this machine; not verified |
| WKWebView, iOS/Android/Windows webviews | lifecycle paths not verified on these hosts |

The worker probe is capability-based, not an OS-version guess. No adapter produces a capability event and visible unavailable report.

### Full-frame engine entry and readback ownership

New engines export `receive(bytes)` as well as the legacy `message(topic, payload)` entry. `receive` gets an immutable copy of the complete generated envelope: kind, source/target lanes, request ID, topic and payload. The compiled GPU example replies to correlated commands on the originating lane with the same ID and topic; RESULT means accepted/queued, not GPU completion. Legacy `message` is retained for uncorrelated traffic; nonzero IDs require `receive` and are explicitly refused otherwise. The page uses `createEngine`, bounded startup queues and nonthrowing `trySend` in UI callbacks; UI deliveries are deferred to avoid callback-time reentry. Host lifecycle failures and capabilities reach the native observer as reports, not only the page log. Debug event/report histories are bounded.

GPU callback buffers are read-only. Successful readbacks stage owned host bytes, then call the guest `readback(offset, bytes)` export before MAP_READY; that export uses `gpu.writeReadback` to write its own arena. The reactor strips readback data before publishing event metadata to the page/native UI. Uploads remain direct linear-memory WebGPU writes. See `gpu/README.md` for readback copy costs and lifetime.

The demo native colour accelerator is Cmd/Ctrl+R, leaving Cmd/Ctrl+K for the command palette. Applications registering their own native shortcuts must reserve them with their command registry.

## State, bulk transfers and frame scheduling

[State and bulk streams](README.md#state-and-bulk-streams) add coalescing STATE traffic in both directions, acknowledged in-page BULK transfers and a demand-driven throughput frame mode. These paths preserve the reliable control limits rather than raising them globally. The stream guide covers admission results, callback ownership, cross-lane ordering, backpressure and the compiled `engineOffer` callback.

[Page-facing host services](../hosts/README.md#page-facing-services) provide persistent native archives, file/media pickers, export/share/gallery operations, incoming documents, print/PDF and page-scoped shortcuts on the Apple and Android reference hosts without adopting the compiled UI framework.

## State and bulk streams

The reliable control lane keeps its 60-message/s and 64 KiB payload limits. Camera drag state, frame-status telemetry and image bytes have separate admission policies; increasing a global control limit is not required.

### Latest state in either direction

```js
import { encodeEngineMessage, ENGINE_STATE, ENGINE_BULK, LANE_UI, LANE_ENGINE } from "../ipc/engine.generated.mjs";

const result = lane.sendLatest(encodeEngineMessage(
  ENGINE_STATE, LANE_UI, LANE_ENGINE, 0, CAMERA_TOPIC, cameraBytes,
));
if (!result.ok) handleEngineUnavailable(result);
```

STATE requires `requestId = 0`. Before delivery, newer state replaces older state with the same source/target/topic. Up to 32 pending topics and one in-flight state delivery are retained. State does not spend reliable-control rate budget. `sendLatest` returns an admission result; `lane.trySend` also accepts STATE if callers need the general nonthrowing API. Await `lane.ready` before offering state or bulk data.

The receiver sees a previously dispatched state followed by the latest pending state; work already being consumed cannot be replaced. Ordering across control, state and bulk lanes is not guaranteed. Include scene/input versions in state and frame reports when they depend on reliable commands. Do not put edits, save commands or other nonreplaceable actions in STATE.

Inside a compiled engine, import `offerState` from `engine/transport.ts` and add this callback to the reactor's library profile:

```json
{ "name": "engineOffer", "params": ["bytes"], "returns": "bool" }
```

```ts
import { offerState } from "../engine/transport.js";
// Call after the relevant CPU/GPU completion point in your application.
offerState(FRAME_STATUS_TOPIC, statusBytes);
```

An engine may offer status every frame without queuing every notification. Include cumulative frame counts and the latest scene/camera version. CPU preparation, GPU submission and GPU completion are different milestones; the host does not reinterpret them as the same event.

### Image and export bytes

BULK permits chunks up to 16 MiB, with two total queued/in-flight deliveries per direction. The lane is confined to page/worker memory. Native JSON/base64 codecs reject BULK, even for small payloads. Messages retain the existing binary envelope; use `requestId` and an application-owned chunk descriptor for export-job correlation and offsets.

```js
const result = lane.sendBulk(encodeEngineMessage(
  ENGINE_BULK, LANE_UI, LANE_ENGINE, jobId, UPLOAD_TOPIC, chunk,
));
if (!result.ok) retainChunkAndRetryLater();
```

The guest equivalent is `offerBulk(topic, requestId, bytes)` from `engine/transport.ts`. Its boolean result is backpressure: advance an offset only after `true`, retain the pending chunk on `false`, and retry after yielding. The legacy void `engineSend` callback cannot provide that acknowledgement and should not be used for lossless transfers.

The page receives outbound frames through `postUi(bytes)`. Its return or resolved promise acknowledges delivery. Keep that callback short; a file-picker interaction is not a transport acknowledgement. The engine copies a borrowed callback buffer before returning and transfers an owned buffer across a Worker boundary. This removes the control-rate ceiling but is not a claim of zero-copy GPU readback or a measured image-export throughput.

Large images/video exports still need bounded chunking, encoding and cancellation. A frame larger than the chunk limit must be split; do not build an unbounded array of queued frames. Generation changes, disposal and worker failure close pending transfers. A stalled acknowledgement fails the stream after 30 seconds rather than allowing retained buffers to grow indefinitely.

### Render scheduling

```js
const lane = await startEngine({ ...options, frameMode: "throughput" });
lane.setFrameMode("display");
lane.setFrameMode("throughput");
```

`display` is the default and preserves `requestAnimationFrame`. `throughput` schedules requested callbacks through MessageChannel tasks, yielding between calls without waiting for display refresh. It remains demand-driven: the guest must request another frame. Switching modes cancels/replaces an outstanding callback; device loss and disposal cancel scheduled work.

This controls work production, not physical presentation or browser/OS background throttling. Bound GPU work using the existing submitted-work completion interface; the scheduler cannot infer application-specific queue depth from a request for another callback.

### Validation

`node --test engine/streams.test.mjs engine/lifecycle-streams.test.mjs gpu/frame-scheduler.test.mjs` covers coalescing during a 1,000-update burst, separate control budgets, copied buffer ownership, bulk acknowledgements/backpressure and main/worker lifecycle paths. The compiled callback probe checks the scriptc boolean callback ABI. These checks do not establish a device image-transfer speedup; measure readback, encoding, copies and delivery separately in the consuming application.

## Experimental native GPU

The macOS host can use an opt-in native executor. See [GPU backend instructions](../gpu/native/README.md). The browser WebGPU path remains the default.
