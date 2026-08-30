# IPC

The protocol between the main process and a renderer process. Both are compiled
binaries; the channel is a TCP socket on `127.0.0.1`.

Main listens on an ephemeral port and passes it to the renderer in `NT_IPC_PORT`.
The renderer connects on startup and the socket stays open for the process
lifetime.

## Frames

Generated from `ipc/protocol.json`. Run `node ipc/generate.mjs` after changing
it; `--check` fails when anything is stale.

<!-- generated:kinds -->
| kind | name | direction | fields |
|---|---|---|---|
| 1 | REQUEST | either | id, channel, payload |
| 2 | RESULT | either | id, payload |
| 3 | ERROR | either | id, message |
| 4 | EVENT | either | channel, payload |

Frame: u32 frame length, then u8 kind.

```
     1 REQUEST  id(u32) channel(u32 length + utf-8) payload(u32 length + raw)
     2 RESULT   id(u32) payload(u32 length + raw)
     3 ERROR    id(u32) message(u32 length + utf-8)
     4 EVENT    channel(u32 length + utf-8) payload(u32 length + raw)
```
<!-- /generated:kinds -->

Request ids are allocated by the sender. `RESULT` and `ERROR` carry the id of
the `REQUEST` they answer. `EVENT` is fire-and-forget and has no id.

Frames may arrive split or coalesced across reads; the codec buffers until a
whole frame is present.

## Surface

`ipc/main.ts`:

    handle(channel, fn)      answer REQUEST from a renderer
    send(channel, payload)   EVENT to the renderer
    listen()                 bind, returns the port

`ipc/renderer.ts`:

    invoke(channel, payload) REQUEST, resolves with the RESULT payload
    on(channel, fn)          receive EVENT
    connect(port)            open the socket

Payloads are `Uint8Array`. `ipc/codec.ts` provides string helpers.
