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

- **Phase 0** — PoC: compiled `main` + compiled `renderer` + webview bridge.
- **Phase 1** — Freeze the DOM Host ABI (opcodes + event protocol). Keystone.
- **Phase 2** — Compile-time-reactive core against the ABI; native-first.
- **Phase 3** — On the scriptc fork: add the browser reactor + host-import wasm
  target; write the JS host; the same framework runs compiled in the browser.
  **Spike done** ([docs/PHASE3_WASM_SPIKE.md](./docs/PHASE3_WASM_SPIKE.md)):
  verdict = *achievable, medium-to-large but well-scaffolded*. scriptc already
  has every hard primitive on the **native** target — library-mode exports
  (reactor shape) and outbound-FFI ptr+len string/bytes marshalling (host-import
  shape) — gated off for wasm by ~2 `if` guards. Plan = 4 small PRs (reactor/
  export lane → wasm host-import ABI → JS glue emission → callbacks), plus a
  `scr_wasm_alloc/free` runtime shim and a `-mexec-model=reactor --no-entry`
  link lane. Needs `zig`/`zigcc` for end-to-end wasm builds (not yet installed).

## Status snapshot

- **Phase 0/1/2 landed on `main`** and verified: native `main`+`renderer` over
  the webview bridge; DOM Host ABI v0 (+ headless conformance test); compile-time
  reactive core (signals/effects/computed, native self-test passes).
- **Benchmark** ([bench/](./bench/)): shipped artifact **~990 KB vs Electron
  ~236 MB (~244×)**; nativetron cold start = 2 procs / ~76 MB RSS (mostly OS
  WebKit). Electron RSS unmeasurable on this host (its unsigned binary is
  SIGKILLed by macOS security policy). The Electron baseline is **opt-in** —
  `npm install electron` is never run automatically (it trips macOS XProtect).

## Repo / fork layout (intended)

- `axelerontech/nativetron` — this repo: framework core, tools, hosts, DOM Host ABI.
- fork of `scriptc` — our compiler; adds the browser reactor + host-import target.
  nativetron pins/depends on the fork; upstream scriptc is reference only.
</content>
</invoke>
