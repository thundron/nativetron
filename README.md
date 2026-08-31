# nativetron

An application framework where TypeScript is compiled ahead of time: to native
machine code for desktop, and to WebAssembly for the browser. The system webview
renders; compiled code drives it through a batched operation protocol.

It compiles a subset of TypeScript through [scriptc](https://github.com/thundron/scriptc).
Existing React, Angular or Vue applications will not build.

## Requirements

macOS arm64, Xcode command line tools, Node 24+, and a built scriptc checkout at
`../../scriptc`. Browser builds also need zig; `wasm-opt` is used if installed.

## Build

```sh
./build.sh                          # desktop: build/main and build/renderer
./build/main

cd web && ./build-web.sh            # browser: .scriptc/renderer.{wasm,mjs}
python3 -m http.server -d web 8000  # open /index.html
```

## Writing a component

Components are functions returning `El`. Signals track dependencies, so `dyn`
re-runs when a value it reads changes and emits only that text update.

```ts
import { el, txt, dyn, on, mountTo } from "../framework/ui.js";
import { signal } from "../framework/reactive.js";

const count = signal(0);

function Counter(): El {
  return el("section", [
    on(el("button", [txt("Increment")]), "click", () => count.set(count.get() + 1)),
    el("p", [dyn(() => `count: ${count.get()}`)]),
  ]);
}

mountTo(el("main", [Counter()]));
```

`each(tag, build)` renders a keyed list and diffs it on change.

## Layout

| path | contents |
|---|---|
| `framework/` | components, signals, reconciler |
| `abi/` | the DOM Host ABI specification |
| `host/` | DOM host runtime used by both lanes |
| `native/` | C++ webview wrapper exposing a C ABI |
| `desktop/` | generated desktop capability contract |
| `app/`, `web/` | desktop and browser entry points |
| `bench/` | benchmarks against React and Electron |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit together, [compat/COMPATIBILITY.md](./compat/COMPATIBILITY.md) for the compiled React/Node surface, and [desktop/COMPATIBILITY.md](./desktop/COMPATIBILITY.md) for native desktop capabilities.
