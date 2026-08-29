# nativetron — architecture & vision

> A from-scratch, resource-efficient application stack where TypeScript is a
> **truly compiled language on every surface** — desktop main process, desktop
> renderer, and the browser — via a **fork of** [`scriptc`](../../scriptc).
> Not a porting tool for old apps; a new, synergetic tool suite for new projects.

## Status decisions (locked)

- **GO on compiler investment.** The browser reactor + host-import wasm target
  (Phase 3) is committed, not conditional. The full "compiled in the browser"
  vision is the target end state.
- **Fork scriptc for full autonomy.** All compiler work (Phase 3, and any
  earlier fixes) lands on our own fork of scriptc, not upstream. This repo
  depends on the fork; upstream is reference only.
- **Compile-time reactive core (Solid/Svelte-style), not runtime-VDOM (Preact).**
  See Design decisions.

## The compiler reality (verified against scriptc source)

scriptc emits exactly two artifact families, and **neither runs inside a
browser/WebView JS engine as page JavaScript**:

| Target | Output | Exports? | DOM / host calls | Runs in browser? |
|---|---|---|---|---|
| **native** (LLVM/C → machine code) | executable, or `--lib` static archive | ✅ C-ABI symbols (reactor-style) | ✅ outbound **FFI** to C (incl. retained callbacks) | ❌ it's machine code |
| **wasm32-wasi** | **command module** (`_start`, runs once, exits) | ❌ `--lib`/reactor refused (`SC3002`) | ❌ no import ABI / no FFI on wasm | ❌ headless WASI, no DOM |

**Consequence:** compiled scriptc code is always the *native host*; the web
engine runs *its own* JS. There is no path today where scriptc TS executes as
the page's JavaScript and calls `document.*` in-engine.

## What is buildable TODAY (validated primitives)

- TS/JS → native executable via `--backend c` (system clang; no llvm@22 helper needed).
- Outbound **FFI** into C (`ffi.json`), including **retained callbacks** — C stores a
  compiled-TS closure and invokes it from a later call (the UI-event mechanism).
- **Native `--lib`** archive exporting C-ABI symbols (embed the framework core).
- Multi-process: `child_process.spawn` + stdio IPC between two compiled binaries.
- The [`webview`](https://github.com/webview/webview) C++ lib links here
  (`-framework WebKit -framework Cocoa` on macOS) and exposes the bridge we need:
  `webview_bind` (JS→native), `webview_eval`/`webview_return` (native→JS),
  `webview_init` (inject bootstrap JS), `webview_run`.
- Inject extra link flags into scriptc's clang step via `CCC_OVERRIDE_OPTIONS`
  (clang driver env hook; scriptc forwards `process.env`).

## The Phase 3 compiler work (committed, on our fork)

An interactive browser renderer needs three things scriptc's wasm target lacks;
we add them on our fork:
1. a **reactor** module (init then *return*; browser calls exported handlers later),
2. a **host-import ABI** (compiled TS calls host JS to touch the DOM),
3. **JS glue** emission.

This is **compiler engineering inside (our fork of) scriptc**, not framework
glue — the true unlock, planned as platform work.

## The unifying abstraction: the DOM Host ABI

One contract every backend implements: a **batched DOM-op command buffer** +
an **event protocol**. The framework core is written once against it.

```
        components (TS, compile-time reactive)
                     │  reconciler emits ▶ [batched DOM-op buffer] + event ids
        ┌────────────┼───────────────────────────────┐
        ▼            ▼                                 ▼
  native webview   browser host (JS, hand-written,    browser host (compiled
  host (C++)       drains SAME buffer) — TODAY        wasm reactor) — LATER,
  → WKWebView DOM                                     needs scriptc target work
```

Same framework source → native desktop today; browser-wasm the day the compiler
target lands, with **no framework rewrite**.

## Design decisions

- **Compile-time reactive (Svelte/Solid-style), NOT runtime-VDOM (Preact-style).**
  Compiled templates → direct fine-grained DOM ops; no runtime diffing, no VDOM
  allocation. scriptc drives the tsc frontend, enabling *framework-aware
  compilation* — the real source of the resource-efficiency claim.
- **webview lib as the desktop core** (it *is* WKWebView on macOS) — modern C++,
  cross-platform (WebView2 / WebKitGTK), nothing lost vs raw WKWebView to start.

## Honest benchmark framing (vs Electron / React)

- vs **Electron**: wins are startup, RSS, binary size, no V8 warmup, no bundled
  Chromium-for-logic. Pixels are still a system webview → "less runtime/memory",
  not "faster paint".
- vs **React in browser** (post Phase 3): win is no JS framework runtime + AOT
  logic + less GC. Layout/paint still the browser engine → "less JS CPU/memory".

## Roadmap

- **Phase 0** — PoC: compiled `main` + compiled `renderer` + webview bridge. **DONE**
- **Phase 1** — DOM Host ABI. **DONE** (v0 JSON, then v1 binary command buffer +
  slot-based events; both encodings live, conformance-tested).
- **Phase 2** — Compile-time-reactive core against the ABI. **DONE**
  (signals/effects/computed; `framework/core.ts` is transport-agnostic and serves
  both the webview and wasm hosts).
- **Phase 3** — Browser reactor + host-import wasm target on the scriptc fork.
  **DONE** — all 4 planned PRs landed. `scriptc build --lib --profile p.json` on
  wasm32-wasi emits `.wasm` + `.mjs`; compiled TS drives the real DOM.

## Status snapshot

Measured (see [bench/](./bench/)):

| axis | result |
|---|---|
| interactions vs React | **1.89x faster**, 100/100 trials, p<0.001 |
| bulk 10k-row rewrite vs React | React 2.5x faster (serialisation tax, structural) |
| browser module size | 63 KB vs React 189.7 KB |
| desktop vs Electron | 296x disk, 4.2x RAM, 1.8x startup, 4x startup CPU |

Compiler work on the fork (branch `internal`): wasm reactor lane, host imports,
glue emission, size (1.88 MB -> 63 KB), plus three perf fixes found by
benchmarking — O(n^2) `Array.sort` -> merge sort, comparator inlining, and array
receiver borrowing (100k numeric sort 387 -> 15 ms).

## Component model (framework/ui.ts)

Composable elements with reactive bindings and keyed lists, shared by both hosts:

```ts
function Counter(): El {
  return el("section", [
    el("h2", [txt("Counter")]),
    on(el("button", [txt("Increment")]), "click", () => count.set(count.get() + 1)),
    el("p", [dyn(() => `count: ${count.get()}`)]),
  ]);
}
```

- `el` / `txt` / `dyn` / `attr` / `on` build trees; components are plain functions
  returning `El`, so composition is ordinary TypeScript.
- `dyn` and `bindText` re-run through the signal graph and emit only the changed
  `SET_TEXT`.
- `each(tag, build)` does keyed diffing, emitting REMOVE and INSERT_BEFORE for
  removals and reorders.
- The same components compile to the native webview app and the browser wasm app.

## Not built yet

- **No JSX**: scriptc's entry accepts `.ts`/`.js` only (no `.tsx`), so JSX needs
  compiler work. The hyperscript API above is the current surface.
- **No tooling**: no CLI (`new` / `dev` / `build`), no dev server, no HMR.
- **Ergonomics**: the webview and wasm lanes need separate entry files and a
  hand-written `profile.json`.
- **Bulk-update tax**: 10k-row rewrites pay ~4 ms of string serialisation vs
  React (see bench/). Small frequent updates win; bulk rewrites do not.

## Repo / fork layout (intended)

- `axelerontech/nativetron` — this repo: framework core, tools, hosts, DOM Host ABI.
- fork of `scriptc` — our compiler; adds the browser reactor + host-import target.
  nativetron pins/depends on the fork; upstream scriptc is reference only.
</content>
</invoke>
