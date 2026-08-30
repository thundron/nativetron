# Architecture

## Compilation targets

scriptc compiles TypeScript to native code or to WebAssembly. Neither runs
inside a JavaScript engine, so compiled code always sits outside the DOM and
drives it through a protocol.

| target | artifact | exports | calls out through |
|---|---|---|---|
| native | executable, or static library | C ABI symbols | FFI, including retained callbacks |
| wasm32-wasi | reactor module | wasm exports | wasm imports |

## Layers

```
components        framework/ui.ts
signals           framework/reactive.ts
reconciler        framework/core.ts        emits batched operations
hosts             native/nativetron_core.cc + webview   (base64 over eval)
                  host/dom-host.js                      (binary over linear memory)
```

The reconciler only speaks the DOM Host ABI, so both hosts run the same
components. `app/renderer.ts` and `web/renderer.ts` differ only in how they
mount and which transport they install.

## Desktop

`app/main.ts` compiles to a native executable that spawns `app/renderer.ts`,
also native. The renderer owns a window through a C++ wrapper around the
[webview](https://github.com/webview/webview) library, and injects
`host/dom-host.js` into the page. Operations cross as base64 inside a constant
`eval` call; page events come back through a retained FFI callback.

## Browser

`web/renderer.ts` compiles to a wasm reactor. Generated glue instantiates it,
supplies host imports and a WASI shim, and calls the exports. Operations cross
as bytes in linear memory; events call exported functions with scalars.

## Compiler fork

The browser lane needed compiler work: a reactor build for wasm32-wasi, host
imports, glue emission, and a size posture. See `FORK.md` in the scriptc fork.

## Limitations

- No JSX. scriptc accepts `.ts` and `.js` entries only.
- Each lane needs its own entry file and a `profile.json` for the browser build.
- No CLI, dev server or hot reload.
- Bulk DOM work (mounting or rewriting thousands of nodes) costs more than an
  in-engine framework, because every node crosses the boundary.
