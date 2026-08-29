# DOM Host ABI

The protocol between a reconciler (compiled TypeScript) and a DOM host (the
environment owning the real DOM). `host/dom-host.js` implements it for both the
native webview and the browser.

Node ids are `u32`. Id 0 is the mount root (`#nt-root`); the reconciler
allocates the rest.

## Operations

| opcode | name | arguments |
|---|---|---|
| 1 | CREATE_ELEMENT | id, tag |
| 2 | CREATE_TEXT | id, text |
| 3 | SET_TEXT | id, text |
| 4 | SET_ATTR | id, name, value |
| 5 | REMOVE_ATTR | id, name |
| 6 | APPEND | parent, child |
| 7 | INSERT_BEFORE | parent, child, ref |
| 8 | REMOVE | id |
| 9 | LISTEN | id, type, slot |
| 10 | UNLISTEN | id, type |
| 11 | SET_PROP | id, name, value |
| 12 | INTERN | id, value |

Operations are sent in batches and applied in order.

## JSON encoding

Used by the native webview, whose bridge is `eval`. A batch is a JSON array of
`[opcode, ...args]`, applied with `window.__nt.apply(batch)`. Strings are inline;
INTERN is unused.

Events arrive as `{"n": nodeId, "t": type, "value": optional}`. The host sends
`{"n": 0, "t": "__ready"}` once the document is ready.

## Binary encoding

Used by the browser wasm lane, applied with `window.__nt.applyBin(bytes)`.
Little-endian: `u8` opcode, `u32` ids, strings as `u32` byte length followed by
UTF-8 bytes. The host receives a zero-copy view of linear memory and must not
retain it.

INTERN registers a string once. CREATE_ELEMENT, SET_ATTR, LISTEN and SET_PROP
carry a `u32` intern id for tag, attribute, event type and property names. Text
content is inline.

Events call exported functions directly: `onEvent(slot)`, or
`onEventValue(slot, value)` when the target has a value. LISTEN carries the slot.
