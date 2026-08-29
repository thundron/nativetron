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
