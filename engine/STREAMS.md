# State, bulk transfers and throughput scheduling

The reliable control lane keeps its 60-message/s and 64 KiB payload limits. Camera drag state, frame-status telemetry and image bytes have separate admission policies; increasing a global control limit is not required.

## Latest state in either direction

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

## Image and export bytes

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

## Render scheduling

```js
const lane = await startEngine({ ...options, frameMode: "throughput" });
lane.setFrameMode("display");
lane.setFrameMode("throughput");
```

`display` is the default and preserves `requestAnimationFrame`. `throughput` schedules requested callbacks through MessageChannel tasks, yielding between calls without waiting for display refresh. It remains demand-driven: the guest must request another frame. Switching modes cancels/replaces an outstanding callback; device loss and disposal cancel scheduled work.

This controls work production, not physical presentation or browser/OS background throttling. Bound GPU work using the existing submitted-work completion interface; the scheduler cannot infer application-specific queue depth from a request for another callback.

## Validation

`node --test engine/streams.test.mjs engine/lifecycle-streams.test.mjs gpu/frame-scheduler.test.mjs` covers coalescing during a 1,000-update burst, separate control budgets, copied buffer ownership, bulk acknowledgements/backpressure and main/worker lifecycle paths. The compiled callback probe checks the scriptc boolean callback ABI. These checks do not establish a device image-transfer speedup; measure readback, encoding, copies and delivery separately in the consuming application.
