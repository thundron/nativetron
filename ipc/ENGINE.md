# Engine IPC

Generated from `ipc/engine.json`. Run `node ipc/generate-engine.mjs --check`.

The low-rate control channel connects native, UI and engine lanes. GPU commands and geometry uploads never use it. Payloads are binary, bounded to 65536 bytes; page transports allow at most 60 messages per second. A topic identifies an application-owned command, not a framework-defined document format. Request ids are caller-owned; result and error responses echo the id.

| field | offset | type |
|---|---:|---|
| version | 0 | u8 |
| kind | 1 | u8 |
| source | 2 | u8 |
| target | 3 | u8 |
| requestId | 4 | u32 |
| topic | 8 | u32 |
| payloadLength | 12 | u32 |

All multibyte fields are little-endian. The payload follows the 16-byte header. Unknown versions, kinds, lanes, same-lane delivery, incorrect lengths and oversized payloads fail closed.

Lanes: NATIVE=0, UI=1, ENGINE=2.

Kinds: COMMAND=1, RESULT=2, ERROR=3, EVENT=4, REPORT=5.

Desktop and mobile message handlers carry `{ ntEngine: 1, frame: base64(frame) }`. JavaScript evaluated by native contains only the base64 alphabet in a fixed call. In-page UI/engine messages use bytes directly, or a Worker postMessage transfer; neither traverses native.

Public codec: `encodeEngineMessage(kind, source, target, requestId, topic, payload): Uint8Array`; `decodeEngineMessage(bytes): EngineMessage | null`.
