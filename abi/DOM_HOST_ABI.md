# DOM Host ABI (v0)

The single contract between a nativetron **reconciler** (compiled TS) and a
**DOM host** (the environment that owns the real DOM). Every backend implements
this same ABI:

- **webview host** (today): C++ core + injected JS runtime (`host/dom-host.js`).
- **browser-wasm host** (Phase 3): the same JS runtime, driven by a compiled
  wasm reactor over the host-import ABI.

Because the reconciler only ever speaks this ABI, the framework is written once
and runs on any host.

## Node ids

Opaque `u32`. Id `0` is the reserved mount root (`#nt-root`). The reconciler
allocates all other ids.

## Command stream (reconciler → host)

A **batch** is a JSON array of ops; each op is `[opcode, ...args]`. Batches are
applied in order via `host.apply(batch)`.

| opcode | name | args | effect |
|---|---|---|---|
| 1 | CREATE_ELEMENT | id, tag | `nodes[id] = createElement(tag)` |
| 2 | CREATE_TEXT | id, text | `nodes[id] = createTextNode(text)` |
| 3 | SET_TEXT | id, text | `nodes[id].textContent = text` |
| 4 | SET_ATTR | id, name, value | `setAttribute` |
| 5 | REMOVE_ATTR | id, name | `removeAttribute` |
| 6 | APPEND | parent, child | `parent.appendChild(child)` |
| 7 | INSERT_BEFORE | parent, child, ref | `parent.insertBefore(child, ref)` |
| 8 | REMOVE | id | detach + free `nodes[id]` |
| 9 | LISTEN | id, type | delegate a DOM listener; fires an event msg |
| 10 | UNLISTEN | id, type | remove the delegated listener |
| 11 | SET_PROP | id, name, value | `nodes[id][name] = value` (e.g. input value) |

Wire format is JSON for v0; the opcode semantics are stable, so a future binary
encoding is a drop-in that does not change the reconciler.

## Event stream (host → reconciler)

On a listened event the host posts one JSON message:

```json
{ "n": <nodeId>, "t": "<type>", "value": "<optional input value>" }
```

Control message `{ "n": 0, "t": "__ready" }` is sent once the document is ready;
the reconciler flushes its initial batch in response.

## v1: binary encoding (wasm lane)

v0's JSON wire format costs a stringify in the guest and a `JSON.parse` in the
host on every interaction. v1 encodes the same opcodes as bytes written straight
into linear memory; the host decodes with `DataView` + `TextDecoder` and applies
via `window.__nt.applyBin(bytes)`. Opcode semantics are unchanged.

Layout, little-endian: `u8 opcode`, node ids as `u32`, strings as `u32 length`
followed by that many UTF-8 bytes.

| opcode | payload |
|---|---|
| 1 CREATE_ELEMENT | u32 id, str tag |
| 2 CREATE_TEXT | u32 id, str text |
| 3 SET_TEXT | u32 id, str text |
| 4 SET_ATTR | u32 id, str name, str value |
| 6 APPEND | u32 parent, u32 child |
| 9 LISTEN | u32 id, str type, u32 slot |

Events skip serialization entirely: `LISTEN` carries a handler `slot`, and the
host calls the exported `onEvent(slot)` (or `onEventValue(slot, value)` when the
target has a value) with scalars only.

The bytes are borrowed for the duration of the call (the glue hands the host a
zero-copy `subarray` of linear memory); the host must not retain them.

Both encodings are live: the native webview lane uses v0 JSON (its bridge is
`eval`, which is text anyway); the wasm lane uses v1.
