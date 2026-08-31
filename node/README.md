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
