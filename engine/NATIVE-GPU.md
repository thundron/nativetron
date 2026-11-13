# Native GPU transport core (`engine/native-gpu.js`)

Status: integrated on macOS. `engine/reactor.js` selects this host when the embedder passes `nativeGpu` (`engine/worker.js` and `engine/host.js` forward it; `engine/page.html` selects it only when the macOS host offers it), and `engine/native-gpu-wire.js` carries the messages over a binary channel to `hosts/macos`, which runs them through the `gpu/native/executor.h` C API. See [hosts/macos/NATIVE-GPU-APP.md](../hosts/macos/NATIVE-GPU-APP.md) for the app side, self-tests and measured results. The tests in this directory still use doubles (`native-gpu.test.mjs`, `native-gpu-wire.test.mjs`); the in-app self-tests are the crossing proof.

## Purpose

`createNativeGpuHost(options)` is a drop-in for the parts of `createGpuHost` that the reactor uses (`apply`, `dispose`, `setFrameMode`, `frameMode`, `requestFrame`, `idle`, `stats`), for the case where a native WebGPU executor (Dawn/wgpu-native behind a generated decoder) runs the op stream instead of the webview. The guest import stays synchronous and void-like:

```js
gpuPresent: (batch, uploads, readbacks) => host.apply(batch, uploads, readbacks)
```

`apply` copies the command batch and the used upload range into owned, chunk-sized `Uint8Array`s (each with its own `ArrayBuffer`, so it can be transferred) before it returns. `gpu/encode.ts` resets both arenas at the end of `flush()` and the next encode overwrites them; no Wasm view is retained. The readback view is only measured (`readbacks.byteLength`, sent as `readbackBytes`); it is never retained or written. Readback bytes come back as transport messages and are delivered as `MAP_READY.data`, which the reactor already copies into the guest through its `readback(offset, bytes)` export from its guarded inbox.

Guest limits are not narrowed: commands 16 MiB, uploads 512 MiB, readbacks 16 MiB (from `gpu/ops.json`, checked by the test). Every bound must admit one maximal flush (528 MiB of commands+uploads); the constructor refuses smaller values.

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
| `chunkHeaderBytes` | Bytes reserved in front of every owned chunk in the same `ArrayBuffer` (default 0; the wire uses 256) so a transport can prepend frame headers without copying. `message.bytes` is a view after the reserve. |
| `maxQueuedBytes` / `maxQueuedSubmissions` / `maxQueuedChunks` | Unacknowledged bounds. Defaults 528 MiB / 8 / derived. |
| `maxFramesInFlight` | Frame credits: frames whose GPU work has not completed. Default 2, at most `NATIVE_GPU_MAX_FRAMES_IN_FLIGHT` (16 = the executor's `NTGPU_EXECUTOR_MAX_FENCES`). |
| `maxReadbackBytes` | Readback reassembly bound, default (and minimum) 16 MiB. |
| `ackTimeoutMs`, `setTimer`, `clearTimer` | No acknowledgement or frame-completion progress within the timeout (default 30 s) is fatal (`ack-timeout` / `frame-timeout`). The timer is armed only while submissions or ended frames are outstanding (no idle timer). |

## Host → native messages (`transport.send(message, transfer)`)

In strict order per engine generation:

- `{ kind: "open", engine, frameMode, limits: { commandBytes, uploadBytes, readbackBytes, chunkBytes } }` — first.
- `{ kind: "submit", engine, sequence, commandBytes, uploadBytes, readbackBytes, chunks }` — header; `sequence` starts at 1 and increases by 1.
- `{ kind: "chunk", engine, sequence, index, section: "commands" | "uploads", offset, bytes, last }` — `index` 1..chunks-1, all command chunks before upload chunks, `offset` within the section, `last` on the final chunk. `transfer` is `[bytes.buffer]`.
- `{ kind: "frame-mode", engine, mode }` — after `setFrameMode`, ordered with submissions.
- `{ kind: "frame-end", engine, frame, through }` — after a frame callback that submitted work returned, ordered after its last chunk: `frame` (increasing) ends at submission `through` (its last flush). The executor fences the GPU work submitted so far and answers `frame-done` when the GPU completed it. Frames without submissions send none.
- `transport.close({ engine, reason })` on dispose or failure; the executor must drop that generation's state.

The executor reassembles the command bytes exactly (they start with the protocol header) and treats upload slice offsets as offsets into the reassembled upload section; readback destinations are offsets into a `readbackBytes`-long arena that it does not own (it returns bytes, not writes).

## Native → host messages (`host.receive(message)`)

`receive` never throws; it returns `false` when the message is ignored as stale or caused a fatal protocol failure.

- `{ type: "ack", engine, sequence }` — cumulative: submissions up to `sequence` are consumed (the executor has copied or executed every byte it needs). Releases bytes/chunks/submissions (the CPU copies) — not frame credits: consumption is not GPU completion. Duplicate or regressing acks are counted in `stats.staleRejected`; an ack beyond what was sent is fatal.
- `{ type: "event", engine, device, event }` — `event` uses the JS host fields for each type (see `gpu/host.js`: CAPABILITIES `available/features/limits…`, SHADER_INFO `messages`, DEVICE_LOST `reason/message`, RESIZE `width/height/dpr`, ERROR `message`, MAP_READY `offset/length`). Any `data` field is stripped; MAP_READY with status OK must be preceded by its complete readback chunks.
- `{ type: "readback", engine, device, requestId, offset, length, at, bytes }` — readback bytes in order (`at` = bytes already sent). A single whole-buffer chunk is adopted (ownership transfers to the host).
- `{ type: "frame-request", engine, device }` — the executor decoded `requestFrame`; the host arms its scheduler (at most one outstanding request, like the JS host).
- `{ type: "frame-done", engine, frame, status }` — the GPU finished every flush of `frame` (status 0), or the work will never run (1 lost: device lost/released; 2 cancelled). Returns that frame's credit, exactly once. It must follow the frame's `frame-end` and the ack of its `through`, else `protocol-violation`; a repeat or an already-retired frame counts as stale; a frame that never ran is a violation. Not filtered by device epoch (credits belong to the engine generation; a lost device's frames complete as lost).
- `{ type: "failed", engine, message }` — executor failure; fatal for the generation.

`device` is the executor's device epoch, with the JS host's `deviceEpoch` semantics: requests of a device settle (LOST/CANCELLED/…) before its DEVICE_LOST event; after DEVICE_LOST at epoch `g`, anything stamped `< g + 1` is rejected, partial readbacks of `g` are discarded and an outstanding frame is cancelled. Messages for another `engine` are rejected.

## Backpressure and failure

`gpuPresent` cannot return backpressure and commands are reliable, so nothing is dropped. Two separate bounds: the **copy queue** (`maxQueuedBytes/Submissions/Chunks`) is released by acks as soon as the executor consumed a submission (fast, CPU-side), and **frame credits** bound GPU work in flight. A frame callback that submits work takes one credit (all of its flushes share it); the credit is returned only by `frame-done`, i.e. after the GPU completed every flush of that frame, so throughput mode cannot run ahead of the GPU into an unbounded GPU queue however fast submissions are consumed. A frame tick runs only while fewer than `maxFramesInFlight` frames hold credits and the submission queue is not full; otherwise the frame waits and is re-requested from the scheduler when a credit returns. Credits do not bound flushes from `start`, `event`, `message` or several flushes inside one export: those are bounded only by the hard limits (and the GPU work of non-frame flushes is still covered by the next frame's fence, which completes only after everything submitted before it). Exceeding a bound is fatal (`queue-exhausted`): `apply` throws a `NativeGpuError` (unwinding the guest export, which the reactor treats as an instance failure), the host releases all queued copies, closes the transport generation and calls `onFailure` (in case guest code caught the throw); every later `apply` throws the same error. Other fatal codes: `transport-failed`, `protocol-violation`, `executor-failed`, `ack-timeout`, `frame-timeout`, `readback-exhausted`, `scheduler-failed`, `event-callback-failed`, `copy-failed`, `internal-error`. Foreign-memory or oversized views are rejected like the JS host (ERROR event, `false`, nothing queued). `dispose()` releases everything, suppresses queued event deliveries and makes `apply` return `false`.

## Integration (done)

1. **Reactor**: `instantiateReactor(prepared, { nativeGpu: { endpoint, session }, engineGeneration, ... })` builds a `createNativeGpuWire` and this host with `chunkHeaderBytes: WIRE_CHUNK_RESERVE` and the wire's tick scheduler. Without `nativeGpu` the WebGPU host (`gpu/host.js`) is used exactly as before. In native mode `resize()` is a no-op: RESIZE events come from the native side (page geometry or the CAMetalLayer surface plan).
2. **Worker/page**: `createEngine({ nativeGpu: { endpoint, session, postGeometry } })` probes the Worker without `navigator.gpu`, `OffscreenCanvas` or rAF (it pings the native endpoint), never transfers the canvas, and reports canvas geometry with `reportNativeGeometry` (layout/mutation driven, deduplicated) instead of resizing it.
3. **Binary channel** (`engine/native-gpu-wire.js`): Worker `fetch` to the page's own `app://` origin, served by a `WKURLSchemeHandler`. Upstream POST bodies carry 32-byte-header frames; every command/upload chunk is its own body whose header (and any pending control frames) is written into bytes reserved in front of the owned chunk, so the transport adds no copy. At most 3 bodies are in flight; the host answers a body only after its executor queue consumed it, which is the backpressure (`send` → `false`, `resume()` on completion). Downstream is one held long-poll per generation (no timers or loops while idle). Messages for other generations are ignored.
4. **Executor**: `hosts/macos/NativeGPUBridge.swift` reassembles submissions (single-chunk sections are passed without a copy, multi-chunk sections are copied once into an exact-size buffer), calls `ntgpu_executor_submit` on a serial queue per generation, then acknowledges. `FRAME_END` (wire kind 8) becomes `ntgpu_executor_fence` on the same queue (at most `NTGPU_EXECUTOR_MAX_FENCES` outstanding, else the generation fails); its completion is sent as `FRAME_DONE` (kind 22, `a` = frame, `b` = status). Executor callbacks only enqueue.
