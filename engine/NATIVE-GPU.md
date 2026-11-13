# Native GPU transport core (`engine/native-gpu.js`)

Status: transport core only. It is not wired into `engine/reactor.js`, `engine/worker.js` or any platform
host, and no native crossing exists yet. The tests use recording doubles; they prove ownership, bounds and
ordering on the JavaScript side, not a native executor, a wire bridge or performance.

## Purpose

`createNativeGpuHost(options)` is a drop-in for the parts of `createGpuHost` that the reactor uses
(`apply`, `dispose`, `setFrameMode`, `frameMode`, `requestFrame`, `idle`, `stats`), for the case where a
native WebGPU executor (Dawn/wgpu-native behind a generated decoder) runs the op stream instead of the
webview. The guest import stays synchronous and void-like:

```js
gpuPresent: (batch, uploads, readbacks) => host.apply(batch, uploads, readbacks)
```

`apply` copies the command batch and the used upload range into owned, chunk-sized `Uint8Array`s (each with
its own `ArrayBuffer`, so it can be transferred) before it returns. `gpu/encode.ts` resets both arenas at the
end of `flush()` and the next encode overwrites them; no Wasm view is retained. The readback view is only
measured (`readbacks.byteLength`, sent as `readbackBytes`); it is never retained or written. Readback bytes
come back as transport messages and are delivered as `MAP_READY.data`, which the reactor already copies into
the guest through its `readback(offset, bytes)` export from its guarded inbox.

Guest limits are not narrowed: commands 16 MiB, uploads 512 MiB, readbacks 16 MiB (from `gpu/ops.json`,
checked by the test). Every bound must admit one maximal flush (528 MiB of commands+uploads); the
constructor refuses smaller values.

## Options

| option | meaning |
| --- | --- |
| `transport` | **required.** `{ send(message, transfer) → boolean, close?({ engine, reason }) }`. `false` = not accepted now; the host keeps the message and retries after `host.resume()`. A throw is fatal. |
| `getMemory` | **required.** Returns the reactor's current `memory.buffer`; all three views must be on it. |
| `engineGeneration` | **required.** Positive integer (the worker's `generation`); stamped on every outbound message and required on every inbound one. |
| `onEvent(event)` | GPU events with the JS host's shape `{ type, requestId, handle, status, ...data }`, on later microtasks in arrival order. |
| `onFrame(time)` | Frame callback (the reactor's `call("frame", time)`). |
| `onFailure(error)` | Fatal `NativeGpuError` for this generation (microtask). The reactor must wire this to its `fail`. |
| `frameMode`, `createScheduler(mode)` | Frame pacing. Default `gpu/frame-scheduler.js`; a platform injects a display-link scheduler with the same `request/cancel/dispose` shape. |
| `chunkBytes` | Wire chunk size, default 4 MiB (multiple of 4, ≥ 4096). |
| `maxQueuedBytes` / `maxQueuedSubmissions` / `maxQueuedChunks` | Unacknowledged bounds. Defaults 528 MiB / 8 / derived. |
| `maxFramesInFlight` | Frame credits, default 2. |
| `maxReadbackBytes` | Readback reassembly bound, default (and minimum) 16 MiB. |
| `ackTimeoutMs`, `setTimer`, `clearTimer` | No acknowledgement progress within the timeout (default 30 s) is fatal. The timer is armed only while submissions are outstanding (no idle timer). |

## Host → native messages (`transport.send(message, transfer)`)

In strict order per engine generation:

- `{ kind: "open", engine, frameMode, limits: { commandBytes, uploadBytes, readbackBytes, chunkBytes } }` — first.
- `{ kind: "submit", engine, sequence, commandBytes, uploadBytes, readbackBytes, chunks }` — header; `sequence` starts at 1 and increases by 1.
- `{ kind: "chunk", engine, sequence, index, section: "commands" | "uploads", offset, bytes, last }` — `index` 1..chunks-1, all command chunks before upload chunks, `offset` within the section, `last` on the final chunk. `transfer` is `[bytes.buffer]`.
- `{ kind: "frame-mode", engine, mode }` — after `setFrameMode`, ordered with submissions.
- `transport.close({ engine, reason })` on dispose or failure; the executor must drop that generation's state.

The executor reassembles the command bytes exactly (they start with the protocol header) and treats upload
slice offsets as offsets into the reassembled upload section; readback destinations are offsets into a
`readbackBytes`-long arena that it does not own (it returns bytes, not writes).

## Native → host messages (`host.receive(message)`)

`receive` never throws; it returns `false` when the message is ignored as stale or caused a fatal protocol
failure.

- `{ type: "ack", engine, sequence }` — cumulative: submissions up to `sequence` are consumed (the executor
  has copied or executed every byte it needs). Releases bytes/chunks/submissions and frame credits.
  Duplicate or regressing acks are counted in `stats.staleRejected`; an ack beyond what was sent is fatal.
- `{ type: "event", engine, device, event }` — `event` uses the JS host fields for each type (see
  `gpu/host.js`: CAPABILITIES `available/features/limits…`, SHADER_INFO `messages`, DEVICE_LOST
  `reason/message`, RESIZE `width/height/dpr`, ERROR `message`, MAP_READY `offset/length`). Any `data`
  field is stripped; MAP_READY with status OK must be preceded by its complete readback chunks.
- `{ type: "readback", engine, device, requestId, offset, length, at, bytes }` — readback bytes in order
  (`at` = bytes already sent). A single whole-buffer chunk is adopted (ownership transfers to the host).
- `{ type: "frame-request", engine, device }` — the executor decoded `requestFrame`; the host arms its
  scheduler (at most one outstanding request, like the JS host).
- `{ type: "failed", engine, message }` — executor failure; fatal for the generation.

`device` is the executor's device epoch, with the JS host's `deviceEpoch` semantics: requests of a device
settle (LOST/CANCELLED/…) before its DEVICE_LOST event; after DEVICE_LOST at epoch `g`, anything stamped
`< g + 1` is rejected, partial readbacks of `g` are discarded and an outstanding frame is cancelled.
Messages for another `engine` are rejected.

## Backpressure and failure

`gpuPresent` cannot return backpressure and commands are reliable, so nothing is dropped. Frame credits gate
`onFrame`: a frame tick runs only while fewer than `maxFramesInFlight` frames have unacknowledged submissions
(all flushes inside one frame callback share one credit) and the submission queue is not full; otherwise the
frame waits and is re-requested from the scheduler on the acknowledgement that frees a credit. Credits do
not bound flushes from `start`, `event`, `message` or several flushes inside one export: those are bounded
only by the hard limits. Exceeding a bound is fatal (`queue-exhausted`): `apply` throws a `NativeGpuError`
(unwinding the guest export, which the reactor treats as an instance failure), the host releases all queued
copies, closes the transport generation and calls `onFailure` (in case guest code caught the throw); every
later `apply` throws the same error. Other fatal codes: `transport-failed`, `protocol-violation`,
`executor-failed`, `ack-timeout`, `readback-exhausted`, `scheduler-failed`, `event-callback-failed`,
`copy-failed`, `internal-error`. Foreign-memory or oversized views are rejected like the JS host (ERROR
event, `false`, nothing queued). `dispose()` releases everything, suppresses queued event deliveries and
makes `apply` return `false`.

## Integration still required

1. **Reactor** (`engine/reactor.js`, owned by the parent): choose the host factory per instance and pass
   `engineGeneration`, `transport`, `onFailure: fail`, `getMemory`, `onFrame`, `onEvent` exactly as for
   `createGpuHost`; `resize`/RESIZE events must come from native presentation (the JS host derives them from
   the canvas on frames). `host.handles/device/adapter` are `null`.
2. **Worker/page** (`engine/worker.js`, `engine/host.js`): the reactor runs in a Worker; chunks must reach
   the native process without crossing the 64 KiB control bridge and without base64. A transport in the
   Worker can transfer chunks to the page (`postMessage` with the transfer list) or post them directly to a
   binary channel if one is reachable from a Worker. Route inbound messages by `engine` generation to the
   live host; drop others.
3. **Platform binary channel** (not implemented, not verified here): candidates on macOS are a
   `WKURLSchemeHandler` receiving POST bodies (`fetch` with `ArrayBuffer` bodies), or a native-hosted
   `WKScriptMessageHandler` only if it carries binary data without encoding. It must report acceptance
   (`send` → `false` + later `resume()`), preserve order per generation, and deliver native → page bytes
   (readback chunks) without base64. Measure copies per hop; the core performs exactly one copy out of Wasm.
4. **Native executor** (other lane): honour the message contract above, acknowledge only after consuming a
   whole submission, emit per-request completion exactly once, stamp the device epoch, send `frame-request`
   on decoded `requestFrame`, and expose a display-link driven scheduler for `createScheduler`.
