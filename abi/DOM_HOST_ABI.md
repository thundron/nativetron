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
| 14 | CREATE_SVG_ELEMENT | id, tag |
| 15 | FOCUS | id |

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
    14 CREATE_SVG_ELEMENT id(u32) tag(u32 intern id)
    15 FOCUS             id(u32)
```
<!-- /generated:ops -->

Operations are sent in batches and applied in order. Unknown opcodes abort the batch; the
base64 desktop lane records a bounded diagnostic instead of silently accepting protocol drift.

## Encoding

Little-endian: `u8` opcode, `u32` ids, strings as `u32` byte length followed by
UTF-8 bytes. Text content is inline; names are interned.

LISTEN carries a callback slot.

<!-- generated:events -->
Schema format 2; native event message version 1, kind `event`.

Browser dispatch is selected by generated default-value semantics:

| semantics | browser callback | guest export | fields after slot |
|---|---|---|---|
| default | `__nt_event` | `onEvent` | — |
| primary | `__nt_event_value` | `onEventValue` | value |
| rich | `__nt_event_rich` | `onEventRich` | value, checked, key, code, modifiers, inputType |

The rich tier has this generated field contract:

| position | field | type | bound/default |
|---:|---|---|---|
| 0 | slot | callback slot | registered u32 slot |
| 1 | value | string | at most 4096 UTF-16 code units; default `` |
| 2 | checked | triBoolean | -1 absent, 0 false, 1 true |
| 3 | key | string | at most 64 UTF-16 code units; default `` |
| 4 | code | string | at most 64 UTF-16 code units; default `` |
| 5 | modifiers | modifierBits | integer bitset 0–15; default `0` |
| 6 | inputType | string | at most 32 UTF-16 code units; default `` |

The callback shapes, tier selection, host projection, guest decoders/exports, native bridge, browser binders, bounds, and event allowlist are generated from `abi/events.json`.
<!-- /generated:events -->

The host only accepts event names declared in that schema. Callback and native-message
validation is exact: missing or extra fields, unsupported message kinds or versions, invalid
lengths, tri-state values, and modifier bits do not dispatch an event.

SET_PROP is not general property access. The host accepts string `value`, boolean
`checked`, `disabled`, `selected`, `indeterminate`, and `readOnly`, plus a bounded
integer `selectedIndex`; every other property fails closed. String property values
are capped at 4096 code units.

CREATE_SVG_ELEMENT always uses the SVG namespace and accepts only `svg`, `g`,
`path`, `circle`, `rect`, `line`, `polyline`, `polygon`, `ellipse`, and `title`.
FOCUS calls focus with scroll prevention and rejects missing/removed/non-focusable
nodes. REMOVE and SET_TEXT recursively forget descendants and detach their
listeners before a stale id can receive a later property or focus operation.

## Transport

The browser passes a zero-copy view of linear memory to `applyBin`; the host must not retain it.
Browser events use one of the generated exact-arity tier callbacks directly: default metadata
crosses with the slot only, primary-only metadata adds one string, and other metadata uses the
rich callback. The Wasm hot path does not serialize or parse JSON.

The desktop webview can only be reached by evaluating source, so operands never appear in it: the
batch is base64-encoded and `window.__nt.applyB64("<base64>")` is evaluated. Incoming webview
messages necessarily use the library's one-argument JSON-array envelope; `framework/dom.ts`
checks that exact shape and a 65,536-code-unit bound before decoding the versioned event object.
See `security/`.
