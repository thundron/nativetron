# Phase 3 — Browser wasm reactor + host-import ABI (scriptc fork) — design spike

> Research + design spike. **No compiler code was changed.** All source
> references below are to the scriptc checkout at `../../scriptc` (paths are
> relative to that repo). Line numbers are from the state examined during the
> spike (`scriptc` HEAD `64b2a285`, "feat(runtime): ship precompiled macOS
> artifacts (#248)"); treat them as anchors, not exact addresses.

## TL;DR / feasibility verdict

**Achievable on this fork. Medium-to-large but well-scaffolded.** scriptc
already contains, on the *native* target, every hard primitive Phase 3 needs —
it just gates them off for wasm:

- **Exports / reactor entry** — the native **library mode** (`mod.lib`) already
  emits a full set of exported C-ABI trampolines (init, per-export functions,
  string/bytes marshalling in/out) instead of a `main`. That is the exact shape
  of a wasm reactor with exported functions; it is refused for wasm today by a
  single `if (buildPlatform === "wasi")` guard.
- **Host-import ABI** — the native **outbound FFI** path (`mod.ffiImports`,
  `ffiCall` IR, ptr+len string/bytes marshalling, retained-callback channels)
  is the precise analog of wasm host imports. It is refused for wasm today by a
  single `if (ffi !== null)` guard. The library-mode **host-callback channels**
  (`scr_library_cb_*`) are an even closer analog (host supplies function
  pointers the guest calls).
- **JS glue** — does not exist at all; it is new emission, but small and
  mechanical (a template driven by `mod.lib.exports` + `mod.ffiImports`).

The real work is not inventing ABI — it is (a) **flipping the two refusal
gates**, (b) teaching the LLVM backend to attach wasm import/export *attributes*
to the FFI/lib symbols (so wasm-ld wires them to the JS host instead of
searching wasi-libc), (c) selecting **reactor** crt/exec-model at link, and
(d) adding a JS-glue emitter. There is **no runtime rewrite**: the marshalling
helpers already work at 32-bit pointer width (the wasm build already runs them
as a WASI command).

Rough size: **~4 small-to-medium PRs** (see Implementation plan). Biggest risk
is that today's wasm path is only exercised as a **WASI command** linking
**wasi-libc**; a browser reactor wants either a trimmed "wasm-only" libc surface
or a documented WASI-shim in the JS host. That is a scoping decision, not a
blocker.

**Toolchain caveat:** the wasm executable lane is `zig cc -target wasm32-wasi`
(`resolveCc`, `native-toolchain.ts:815-835`). **`zig` is not installed on this
host**, so the end-to-end `.wasm` probe was **skipped**. The IR-level probe
(below) ran with the prebuilt CLI and confirmed the entry-point and refusal
shapes without zig.

---

## 1. Current state — how the wasm/WASI path works today

### 1.1 Target selection & the driver

- **`packages/compiler/src/backend/native-toolchain.ts`**
  - `resolveCc(env, hostPlatform)` (**~L749**) maps `SCRIPTC_CC`/`SCRIPTC_TARGET`
    to a `CcDriver`. `SCRIPTC_TARGET=wasm32-wasi` requires `SCRIPTC_CC=zigcc`
    (plain clang has no cross sysroot — **L755-761**). The wasm branch
    (**L815-835**) yields `argv:["zig","cc"]`, `-target wasm32-wasi`,
    `-D_GNU_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS`, and
    links `-lwasi-emulated-signal -lwasi-emulated-process-clocks`.
  - `configuredTargetPlatform(env)` (**~L860**) is the pure classifier:
    `wasm32-wasi` → `"wasi"`; any other `*wasi*` triple is rejected
    (**L856-859**); `targetPlatform(driver)` (**~L878**) is the driver-bound
    version. `"wasi"` is the platform token every wasm-conditional keys on.
  - Executable link path: `compileC`/`compile` build the program TU with the
    driver and link. For wasi, `scr_child.c` is dropped from
    `EXECUTABLE_RUNTIME_SOURCES` and `-pthread` is omitted
    (**L3981-3988**). `supportedNativeCacheWarmProfiles` returns `[]` for wasi
    (**L5287**). The link produces `<stem>.wasm` (`index.ts:1555`).
  - **`_start` is not emitted by scriptc.** scriptc emits
    `__main_argc_argv` (see 1.3); wasi-libc's `crt1-command.o` — pulled in by
    `zig cc` for a `wasm32-wasi` **command** module — defines `_start`, runs
    ctors, calls `__main_argc_argv`, then calls `__wasi_proc_exit`. That
    "run-once-then-exit" is exactly the COMMAND semantics we must replace with a
    reactor for Phase 3.

### 1.2 The build/refusal orchestration

- **`packages/compiler/src/index.ts`** — `compile(...)` around **L1517-1537**
  is the wasi capability gate, run right after lowering + IR validation:
  ```
  if (buildPlatform === "wasi") {
    if (opts.sanitize)  return fail([targetRefusalDiag("wasm32-wasi", "--sanitize", …)]);
    if (ffi !== null)   return fail([targetRefusalDiag("wasm32-wasi", "native FFI manifests", …)]);   // ← host-import gate
    const unavailable = moduleWasiUnavailableSurface(lowered.module);
    if (unavailable !== null) return fail([targetRefusalDiag("wasm32-wasi", unavailable.surface, …)]);
    if (opts.backend === "c" || outputKind === "c") { …async surface refusal… }
  }
  ```
  - wasm **forces the LLVM backend**: a C-backend async surface is refused
    (**L1531-1537**), and an LLVM tier-refusal is fatal for wasi rather than
    falling back to C (**L1678-1681**). So the wasm artifact always comes from
    `emitLlvmModule`.
  - IR/LLVM emission passes `pointerBits: buildPlatform==="wasi" ? 32 : 64` and
    `wasi: buildPlatform==="wasi"` to `emitLlvmModule`
    (**L1592-1593, L1664-1665**).

### 1.3 The LLVM entry point (command vs. the missing reactor)

- **`packages/compiler/src/backend/llvm/emitter.ts`**
  - `LlvmTargetOptions.wasi` (**L169-173**) selects "the WASI libc entry-point
    convention"; `this.wasi` (**L375**), `this.sizeType` is `i32` under wasm.
  - The entry define (**~L1282**):
    ```ts
    `define i32 @${this.wasi ? "__main_argc_argv" : "main"}(i32 %argc, ptr %argv) …`
    ```
    i.e. wasi emits `__main_argc_argv` (the wasi-libc command hook) instead of
    `main`. The body calls `scr_init()`, installs event/loop hooks, calls
    `scr_lib_init(argc,argv)`, then the entry function — **run once, return exit
    status** — and wasi-libc's `_start` wrapper turns that return into
    `proc_exit`.
  - **Library mode replaces `main` entirely** (**L1271-1279**): when
    `mod.lib !== undefined`, no `@main`/`@__main_argc_argv` is emitted; instead
    `emitLibDefs(...)` emits the profile-declared external symbols. **This is the
    reactor-shaped codegen we want on wasm.**

### 1.4 Native library / reactor export machinery (the template for #1)

- **`packages/compiler/src/frontend/lib-exports.ts`** — `entryFunctionExports`
  + `EntryExportInfo`: collects every `export function f(...)` of the entry
  module (name, loc, generic/async/generator flags) — the raw export surface,
  fenced by SC4002/4004/4007.
- **`packages/compiler/src/ir/ir.ts`** — `IrLibSection` (**L1014+**),
  `IrLibExport` (**L955+**), `IrLibCallback` (**L991+**), `IrFfiImport`
  (**L942+**). `IrLibExport` carries `{symbol, fnName, params[], returns,
  inboundBytesTrap?, inboundIntTrap?}` with param/return classes
  `f64|bool|string|bytes|u8|u32|i32|i64|u64`.
- **`emitter.ts` `emitLibDefs`** (**~L1420-1600**) emits, per library module:
  - `@<initSymbol>()` — deterministic reset + run the entry (init) —
    **the reactor's `_initialize` analog** (**L1472-1483**).
  - `@<sinkRegisterSymbol>(fn,ctx)`, optional `@<resultResetSymbol>`,
    `@<collectSymbol>`, identity getters.
  - the **host-callback registration** define `@<callbackRegisterSymbol>
    (name,fn,ctx)` — a strcmp dispatch storing host function pointers into
    runtime slots via `scr_library_cb_set(slot,fn,ctx)` (**L1493-1526**).
  - one exported trampoline **per `lib.exports` entry** (**L1558+**): prologue
    `scr_library_entry(reset, symConst)`, then argument marshalling using
    `scr_library_str_in/bytes_in/i64_in/u64_in` (**declared L1012-1028**) and
    result marshalling `scr_library_str_out/bytes_out`, then the call to
    `@<mangled fnName>`.
- The runtime side of that ABI lives in the C runtime (`scr_library.c`, wired by
  `LIB_RUNTIME_SOURCES`, `native-toolchain.ts:922-928`): `scr_library_entry`,
  `_reset`, `_str_in/out`, `_bytes_in/out`, `_cb_set`, `_cb_require`, `_cb_ctx`.

### 1.5 Outbound native FFI (the template for #2)

- **`packages/compiler/src/ffi/ffi-manifest.ts`** — the `ffi.json` loader.
  Value classes `FFI_PARAM_CLASSES = f64|bool|u8|u32|i32|string|bytes`,
  returns `f64|bool|u8|u32|i32|void`; string/bytes expand to a **borrowed
  (ptr,len) pair** for the call's duration (header comment, **L1-60**).
  Formats 1-5 add exact-position callbacks, copy-in cstring/string/bytes,
  retained + foreign-thread callbacks. This IS the cross-boundary marshalling
  contract to reuse for wasm.
- Lowering: a call to an FFI binding becomes an `ffiCall` IR node carrying the
  binding name; `mod.ffiImports: IrFfiImport[]` holds the resolved manifest.
- Backend emission:
  - **C backend** `c-emitter.ts:749-779`: for each direct FFI import emit
    `extern <ret> <symbol>(<params…>);` (string/bytes → `const uint8_t *,
    size_t`); `c/exprs.ts:2062+` emits the marshalled call (borrow buffers,
    ToUint32/ToInt32 for u32/i32, exact f64 widen for scalar returns).
  - **LLVM backend** `emitter.ts` `emitCallExpr` (**L3951+**) does the same at
    IR level; retained/foreign callbacks flow through `scr_ffi_*` runtime.
  - **Library callback channels** reuse the *same* `ffiCall` IR but dispatch
    through `scr_library_cb_require(slot,trap)` + `scr_library_cb_ctx(slot)`
    (`c/exprs.ts:2062-2126`) — host supplies the pointer, guest calls it. This
    is functionally "host imports resolved at registration time" and is the
    closest existing analog to wasm imports (wasm resolves at instantiation
    instead).

### 1.6 Where a "wasm library/reactor" is refused

- **`index.ts` `compileLibrary…`** (**~L2620-2632**):
  ```ts
  if (buildPlatform === "wasi") {
    return fail([targetRefusalDiag("wasm32-wasi", "library-mode archive builds", …)]);
  }
  ```
  This is the SC3002-family (`targetRefusalDiag`) refusal the ARCHITECTURE.md
  calls "`--lib`/reactor refused". Library mode also refuses runtime-symbol
  localization for non-darwin/linux/win32 (**native-toolchain.ts:1865-1872**),
  but the wasi cut-off happens first, in `index.ts`.

---

## 2. Gap analysis (per capability, with the exact rejecting site)

### #1 Reactor module (init-then-return + callable exports)
- **Gap A — no export surface on the wasm lane.** The wasm executable lane emits
  `@__main_argc_argv` (`emitter.ts:1282`) and never `mod.lib` trampolines,
  because `mod.lib` is only populated by `compileLibrary`, which **refuses wasi
  outright** (`index.ts:~2625`). Even if populated, `emitLibDefs` emits **plain
  external** LLVM symbols — for wasm-ld those are ordinary defined functions,
  not module *exports* unless given an export attribute / `--export`.
- **Gap B — command crt forces exit.** `zig cc -target wasm32-wasi` links
  `crt1-command.o` → `_start` → `proc_exit`. There is no code path selecting
  `-mexec-model=reactor` / `crt1-reactor.o` (grep for `reactor`/`exec-model`/
  `no-entry` in `native-toolchain.ts` → **none**). So today's module always
  exits; a reactor must not.

### #2 Host-import ABI (compiled TS calls host JS)
- **Hard gate:** `index.ts:1523`
  `if (ffi !== null) return fail([targetRefusalDiag("wasm32-wasi", "native FFI manifests", …)])`.
  Confirmed by probe (§4): building any `--ffi` manifest for `wasm32-wasi`
  fails with `error SC3002: wasm32-wasi target does not support native FFI
  manifests`.
- **Secondary gap:** even with the gate removed, FFI symbols lower as plain
  `extern <ret> <symbol>(...)` (C) / `declare <ret> @<symbol>(...)` (LLVM). For
  a browser reactor these must become **wasm imports** (`(import "env"
  "<symbol>" (func …))`), which in LLVM means attaching
  `"wasm-import-module"`/`"wasm-import-name"` function attributes (or, in C,
  `__attribute__((import_module,import_name))`) so wasm-ld leaves them
  unresolved-as-imports instead of erroring on an undefined symbol.
- **Retained/foreign-thread callbacks** (FFI formats 4/5, `scr_ffi_*`,
  `scr_async` worker) have **no browser analog** — there is no native thread
  pool in a wasm module. Phase 3 should restrict the wasm host-import ABI to
  **format 1-3** (value + call-lifetime + copy-in callbacks) and refuse
  retained/foreign on wasm, or route them through the JS event loop later.

### #3 JS glue emission
- **Total gap.** Grep shows no `.mjs`/`.js` loader emission anywhere in the
  backend; the only wasm artifact is `<stem>.wasm` (`index.ts:1555`). Nothing
  instantiates the module, provides imports, or re-exports functions. This is
  net-new (but small) emission.

---

## 3. Design

### 3.1 Module shape

A Phase-3 browser artifact is a **wasm reactor**:

```
(module
  ;; imports: one per host-provided function (the wasm host-import ABI)
  (import "nt" "dom_set_text"  (func $dom_set_text (param i32 i32)))      ;; (ptr,len)
  (import "nt" "dom_get_value" (func $dom_get_value (param i32 i32) (result f64)))
  ;; the guest's own linear memory, exported so JS can read/write strings/bytes
  (memory (export "memory") 2)
  ;; reactor lifecycle + guest allocator (for host→guest string/bytes)
  (func (export "_initialize") …)      ;; wasi reactor ctor hook (was crt1-reactor)
  (func (export "scr_wasm_alloc") (param i32) (result i32))   ;; host stages bytes here
  (func (export "scr_wasm_free")  (param i32 i32))
  ;; the app's exported handlers (from `export function onClick(...)`)
  (func (export "onClick") (param …) (result …)))
```

- **Exports** = `mod.lib.exports` (reuse `IrLibExport`) + a fixed support set
  (`memory`, `_initialize`, `scr_wasm_alloc`, `scr_wasm_free`). The existing
  export trampolines (`emitLibDefs`) are reused verbatim; only their *linkage
  visibility* changes (export attribute / `--export`).
- **Imports** = `mod.ffiImports` (reuse `IrFfiImport`), each becoming an
  `(import "<module>" "<symbol>" …)`.

### 3.2 Memory / ABI contract (reuse the FFI marshalling design)

The **existing** contract already fits wasm because wasm linear memory *is* the
"ptr+len" world the FFI marshalling assumes (just at 32-bit pointers, which the
wasi build already uses — `pointerBits:32`, `sizeType:i32`):

| Value class | Guest→Host (import call / export return) | Host→Guest (export arg / import result) |
|---|---|---|
| `f64` | wasm `f64` param | wasm `f64` |
| `bool`/`u8`/`u32`/`i32` | wasm `i32` (existing ToUint32/ToInt32/exact-f64) | wasm `i32` |
| `string`/`bytes` | pass `(i32 ptr, i32 len)` into guest linear memory — borrowed for the call (already the FFI rule) | host calls exported `scr_wasm_alloc(len)`, writes bytes into `memory`, passes `(ptr,len)`; guest copies in via existing `scr_library_bytes_in`/`str_in`, host frees or guest owns per existing ownership rules |

- **No new marshalling helpers.** `scr_library_str_in/out`, `bytes_in/out`,
  `i64_in/u64_in` already exist and already run in the wasm build. Import
  (host-call) marshalling reuses the `ffiCall` value-class plumbing from
  `c/exprs.ts:2062+`. The only *new* runtime surface is the two allocator
  exports (`scr_wasm_alloc/free`) — thin wrappers over the runtime's existing
  arena/malloc so JS can stage inbound strings/bytes.
- **Callbacks across the boundary:** call-lifetime callbacks (FFI format 2/3)
  map to a host import that takes a guest **table index** (funcref) + context
  ptr; the guest exports a small dispatch (mirrors `scr_ffi_call_*`). Retained
  (format 4) and foreign (format 5) callbacks are **refused on wasm** in the
  first cut (no thread pool / no synchronous host retention story yet).

### 3.3 Reactor entry vs. `_start`

- Select **reactor exec-model at link**: add `-mexec-model=reactor` to the wasm
  link (zig cc / clang), which swaps `crt1-command.o` for `crt1-reactor.o`.
  The reactor crt exports **`_initialize`** (runs ctors, no `proc_exit`) and
  omits `_start`.
- scriptc's `@__main_argc_argv` body (init + run entry) is **repurposed**: for a
  reactor we still want one-time init, so emit an exported
  `_initialize`-driven init that runs `scr_init()` + module top-level
  (equivalently `mod.lib.initSymbol`'s body) and **returns** rather than exiting.
  Concretely: when `mod.lib` is present on the wasi lane, `emitLibDefs` already
  emits `@<initSymbol>()` (init-then-return); we simply **export it as
  `_initialize`** (or call it from the reactor ctor) and emit **no `main`**.
- Net: the reactor is "library mode, emitted for the wasi platform, linked with
  the reactor crt, with wasm export/import attributes on the boundary symbols."

### 3.4 Emitted JS glue

A generated `<stem>.mjs` beside `<stem>.wasm` (template driven by
`mod.ffiImports` + `mod.lib.exports`):

```js
export async function instantiate(hostImpls) {
  const bytes = await (await fetch(new URL("./<stem>.wasm", import.meta.url))).arrayBuffer();
  let exports;
  const memU8 = () => new Uint8Array(exports.memory.buffer);
  const readStr = (ptr, len) => new TextDecoder().decode(memU8().subarray(ptr, ptr + len));
  const passStr = (s) => { const b = new TextEncoder().encode(s);
    const p = exports.scr_wasm_alloc(b.length); memU8().set(b, p); return [p, b.length]; };
  const imports = { nt: {
    dom_set_text: (ptr, len) => hostImpls.dom_set_text(readStr(ptr, len)),
    dom_get_value: (ptr, len) => hostImpls.dom_get_value(readStr(ptr, len)),
    // …one wrapper per mod.ffiImports entry, marshalling per value class…
  }};
  const inst = (await WebAssembly.instantiate(bytes, imports)).instance;
  exports = inst.exports;
  exports._initialize?.();
  return {
    onClick: (arg) => { const [p, n] = passStr(arg); return exports.onClick(p, n); },
    // …one wrapper per mod.lib.exports entry…
  };
}
```

The glue is fully derivable from IR facts already on `IrModule`; it needs a
`emitWasmGlue(mod): string` function and a write step next to the `.wasm`.

---

## 4. Probe (what actually ran)

- **`zig` / `zigcc` not installed** on this host → the end-to-end `.wasm` build
  and `wasm-objdump`/`wasm2wat` inspection were **skipped** (as the brief
  allows). `wasm2wat`/`wasm-objdump` also absent.
- **IR-level probe ran** against the prebuilt CLI
  (`packages/cli/dist/main.js`, Node v24.19.0), which needs no zig:
  - `SCRIPTC_TARGET=wasm32-wasi … build --emit llvm` on a trivial
    `console.log` program → LLVM IR with **`define i32 @__main_argc_argv(i32
    %argc, ptr %argv)`** and 32-bit shapes (`%ScrStr = type { i32, i32, i32 }`).
    Host build of the same file emits `define i32 @main(...)`. Confirms 1.3:
    wasm is a WASI **command** hook, no `_start`/`_initialize`/exports in the IR
    (they are crt/link-provided).
  - `SCRIPTC_TARGET=wasm32-wasi … build --ffi ffi.json --emit llvm` →
    **`error SC3002: wasm32-wasi target does not support native FFI
    manifests`**. Confirms the #2 host-import gate at `index.ts:1523`.
  - The wasm `.ll` carries **no `target triple`/`target datalayout`** line — the
    triple is supplied to `zig cc`/`clang` on the command line, not embedded in
    the module. (So the reactor exec-model + import/export wiring all live at the
    **link/attribute** layer, reinforcing §3.3.)
- The library-mode wasi refusal (`index.ts:~2625`) was read directly rather than
  reproduced (a valid profile fixture was out of scope for the time box).

---

## 5. Implementation plan (ordered, file-by-file, small PRs)

### PR 1 — Admit a wasm reactor/export lane (no imports yet)
1. `index.ts` (~L2620): replace the blanket
   `if (buildPlatform === "wasi") return fail([targetRefusalDiag(…"library-mode
   archive builds"…)])` with a wasi-aware branch that **allows** the reactor
   path (keep refusing the *native static-archive* localization/threading bits
   that have no wasm meaning — `localizeRuntime`, `instance_per_thread`,
   mobile-only knobs).
2. `emitter.ts`: when `this.wasi && mod.lib !== undefined`, emit the lib
   trampolines (already done by `emitLibDefs`) **and** mark each `lib.exports`
   symbol + `initSymbol` (+ `memory`) as a wasm export — via LLVM
   `"wasm-export-name"` attribute or by recording an export list the linker gets
   as `-Wl,--export=<sym>`.
3. `native-toolchain.ts` (wasm link, ~L3981/link assembly): add
   `-mexec-model=reactor` and `-Wl,--export=…`/`--no-entry` for the wasi lib
   lane; keep the command lane (`__main_argc_argv`) unchanged for plain wasm
   executables.
4. Add `scr_wasm_alloc`/`scr_wasm_free` runtime exports (thin arena/malloc
   wrappers in the C runtime; gated to the wasi lib lane).
- **Risk:** wasi-libc vs. "pure wasm" — reactor still links wasi-libc; the JS
  host must provide a minimal WASI shim (or we trim to `wasm32-unknown` later).
  Decide: ship WASI-reactor first (host provides a tiny `wasi_snapshot_preview1`
  shim), migrate to freestanding later.

### PR 2 — Host-import ABI on wasm
5. `index.ts:1523`: drop the `ffi !== null` wasi refusal; instead **validate**
   the manifest is import-only format 1-3 (refuse retained/foreign FFI on wasm
   with a new targeted SC-code).
6. `emitter.ts` (`emitCallExpr` FFI path, ~L3951) / `c-emitter.ts:776`: when
   `this.wasi`, attach `"wasm-import-module"`/`"wasm-import-name"` attributes to
   each `mod.ffiImports` `declare`/`extern` so wasm-ld emits them as imports
   (module name from a new manifest field, default `"env"`).
7. Reuse the existing `ffiCall` marshalling unchanged (ptr+len, ToUint32 etc.).
- **Risk:** `string`/`bytes` **return** values are still format-1-scalar-only in
  FFI; keep that restriction on wasm (host returns scalars or writes into a
  guest-provided buffer).

### PR 3 — JS glue emission
8. New `packages/compiler/src/backend/wasm-glue.ts`: `emitWasmGlue(mod)` builds
   the `.mjs` from `mod.ffiImports` + `mod.lib.exports` (§3.4). Pure string
   emission, unit-testable without zig.
9. `index.ts` wasm artifact step (~L1555): after writing `<stem>.wasm`, write
   `<stem>.mjs`; add an artifact kind so the CLI reports both.

### PR 4 — Callbacks across the boundary (optional, later)
10. Map FFI format-2/3 call-lifetime callbacks to host-import + guest table
    dispatch; refuse format 4/5 on wasm. Extend the glue accordingly.

### Cross-cutting
- Tests: mirror `native-codegen.test.ts` / emitter tests with wasi + lib/ffi
  fixtures asserting export/import attributes in the `.ll` (no zig needed);
  gate any end-to-end `.wasm` test behind `zig` availability.
- New diagnostics: a wasm-import validation code and a "retained/foreign FFI
  unsupported on wasm" code (extend `diagnostics/diagnostic.ts` SC3002 family or
  a new SC30xx).

### Open questions
- **libc surface:** WASI-reactor + host shim, or freestanding `wasm32-unknown`
  (needs a scriptc runtime port off wasi-libc — larger)? Recommend WASI-reactor
  first.
- **Import module namespace:** single `"env"`/`"nt"` vs. per-manifest — add one
  optional manifest field.
- **Memory growth / ownership:** confirm `scr_wasm_alloc` interacts correctly
  with the runtime arena reset that `scr_library_entry` performs per call.
- **Reactor + top-level side effects:** module top-level currently runs in the
  entry function; for a reactor it must run exactly once in `_initialize` and
  must not `proc_exit`.

---

## 6. The 5-10 files/functions that must change

1. **`index.ts` ~L2620 (`compileLibrary…` wasi refusal)** — allow the reactor
   lane for `buildPlatform==="wasi"` instead of `targetRefusalDiag(…"library-mode
   archive builds")`.
2. **`index.ts:1523` (wasi FFI gate)** — replace the blanket FFI refusal with
   import-only manifest validation (refuse retained/foreign).
3. **`backend/llvm/emitter.ts` `emitLibDefs` / entry emission (~L1271-1600)** —
   emit lib trampolines on the wasi lane and attach wasm **export** attributes;
   export `initSymbol` as/through `_initialize`; emit no `main`.
4. **`backend/llvm/emitter.ts` `emitCallExpr` FFI path (~L3951)** — attach
   wasm **import** attributes to FFI `declare`s when `this.wasi`.
5. **`backend/c/c-emitter.ts:776`** — same wasm-import attribute on the C-backend
   `extern` (only if the C backend is ever used for wasm; today wasm forces
   LLVM, so this is optional/defensive).
6. **`backend/native-toolchain.ts` wasm link (resolveCc ~L815 + exe link
   ~L3981)** — add `-mexec-model=reactor`, `--no-entry`, and `--export`/import
   flags for the reactor lane.
7. **C runtime (`native/…/scr_library.c` or a new `scr_wasm.c`)** — add
   `scr_wasm_alloc`/`scr_wasm_free`; wire into `LIB_RUNTIME_SOURCES` for wasi.
8. **New `backend/wasm-glue.ts` + `index.ts` artifact step (~L1555)** —
   `emitWasmGlue(mod)` and write `<stem>.mjs`.
9. **`ffi/ffi-manifest.ts`** — optional `import_module` field; wasm
   format-restriction validation.
10. **`diagnostics/diagnostic.ts`** — new codes for wasm-import validation /
    unsupported retained-FFI-on-wasm.

Reusable-as-is (no change): `frontend/lib-exports.ts`, `IrLibExport`/
`IrLibSection`/`IrFfiImport` shapes, the `scr_library_str_in/out`,
`bytes_in/out`, `cb_*` runtime marshalling — the entire cross-boundary ABI
already exists and already runs at 32-bit pointer width in the wasm build.
