# DOM Host ABI

The protocol between a reconciler (compiled TypeScript) and a DOM host (the
environment owning the real DOM). `host/dom-host.js` implements it for both the
native webview and the browser.

Node ids are `u32`. Id 0 is the mount root (`#nt-root`); the reconciler
allocates the rest.

## Operations

Generated from `abi/ops.json`. Run `node abi/generate.mjs` after changing it;
`--check` fails when anything is stale.

<!-- generated:ops -->
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
| 13 | ELEMENT_WITH_TEXT | parent, id, tag, textId, text |

Wire layout:

```
     1 CREATE_ELEMENT    id(u32) tag(u32 intern id)
     2 CREATE_TEXT       id(u32) text(length-prefixed utf-8)
     3 SET_TEXT          id(u32) text(length-prefixed utf-8)
     4 SET_ATTR          id(u32) name(u32 intern id) value(length-prefixed utf-8)
     5 REMOVE_ATTR       id(u32) name(u32 intern id)
     6 APPEND            parent(u32) child(u32)
     7 INSERT_BEFORE     parent(u32) child(u32) ref(u32)
     8 REMOVE            id(u32)
     9 LISTEN            id(u32) type(u32 intern id) slot(u32)
    10 UNLISTEN          id(u32) type(u32 intern id)
    11 SET_PROP          id(u32) name(u32 intern id) value(length-prefixed utf-8)
    12 INTERN            id(u32) value(length-prefixed utf-8)
    13 ELEMENT_WITH_TEXT parent(u32) id(u32) tag(u32 intern id) textId(u32) text(length-prefixed utf-8)
```
<!-- /generated:ops -->

Operations are sent in batches and applied in order.

## Encoding

Little-endian: `u8` opcode, `u32` ids, strings as `u32` byte length followed by
UTF-8 bytes. Text content is inline; names are interned.

Events call exported functions directly: `onEvent(slot)`, or
`onEventValue(slot, value)` when the target has a value. LISTEN carries the slot.

## Transport

The browser passes a zero-copy view of linear memory to `applyBin`; the host
must not retain it.

The desktop webview can only be reached by evaluating source, so operands never
appear in it: the batch is base64-encoded and `window.__nt.applyB64("<base64>")`
is evaluated. See `security/`.
