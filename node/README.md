# Node bindings

A Node addon over the same C ABI the compiled lane uses, plus a
`react-reconciler` host config on top. React apps render into the native window
without a compile step.

    npm install
    npx node-gyp configure build
    node test.mjs

## Layers

    react.mjs      react-reconciler host config -> Encoder
    index.mjs      Encoder (abi/ops.json) + Window (lifecycle, events, pump)
    addon.cc       napi -> C ABI
    ../native/nativetron_core.cc

The addon exposes the C ABI unchanged:

| addon | C ABI |
|---|---|
| `applyBatch(bytes)` | `nt_send_ops` |
| `pump()` | `nt_pump` |
| `onMessage(fn)` | `nt_on_message` |
| `init` / `setTitle` / `setSize` / `setHtml` / `addInit` / `eval` / `activate` / `terminate` | same names |

`Encoder` writes the same binary op stream as `framework/core.ts`, generated
from `abi/ops.json`, so the host in `host/dom-host.js` is shared with the
compiled and browser lanes.

## Event loop

`nt_pump` drains pending AppKit events and returns whether the window closed.
`Window.run()` calls it from a `setTimeout` loop, so Node's event loop stays
live and the window stays responsive.

## Supported today

Elements, text, attributes, `style` objects, `className`/`htmlFor`, `on*`
handlers, keyed children, state and hooks. Handlers are stored in JS and
addressed by slot; the host only knows a listener exists.

Not covered: portals, suspense, refs to host nodes, controlled inputs,
synthetic event objects (handlers receive the host's value string).

## Cost against the compiled lane

10k rows, op stream produced with no window and no host apply, so it is
comparable to the guest encode number in `bench/codec`. Medians of 7.

| | react (node) | compiled |
|---|---:|---:|
| mount, produce ops | 25.28 ms | 1.50 ms |
| mount wire bytes | 407,803 | 347,773 |
| update, produce ops | 30.22 ms | — |
| update wire bytes | 227,746 | 227,779 |

React costs roughly 17x the compiled encoder to produce the same mount, and
carries 1.17x the bytes: the compiled lane emits one `ELEMENT_WITH_TEXT` where
the reconciler emits `CREATE_ELEMENT` plus `SET_TEXT`. Update wire size matches.

`shouldSetTextContent` for single string/number children is worth 19% of mount
time and 18% of mount bytes against creating separate text nodes.
