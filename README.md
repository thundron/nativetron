# nativetron

TypeScript as a **compiled** language for apps. An Electron-like desktop model
where both the **main** and **renderer** processes are AOT-compiled to native
machine code via [scriptc](../../scriptc) — no Node, no V8, no bundled Chromium
runtime for your logic. The UI is drawn by the system webview
([webview](https://github.com/webview/webview): WKWebView / WebView2 /
WebKitGTK), driven from native code over a small bridge.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full vision and roadmap.

## Phase 0 PoC (this repo)

- `native/nativetron_core.cc` — modern-C++ wrapper over the webview library,
  exposing a scriptc-FFI C ABI (init / set_html / eval / on_message / run).
- `app/renderer.ts` — the renderer, compiled to native. Owns the window, renders
  a page, and handles the button click **in native code**, pushing the DOM
  update back over the bridge.
- `app/main.ts` — the main process, compiled to native. Spawns the renderer.
- `ffi/nativetron.ffi.json` — the FFI manifest (uses a retained callback for
  inbound page→native messages).

### Build & run

```sh
./build.sh          # -> build/main, build/renderer (both native arm64)
./build/main        # main spawns the renderer window
```

Requirements: macOS arm64, Xcode CLT (clang), Node 24+, and a built scriptc CLI
at `../../scriptc` (`corepack pnpm install && pnpm -r --filter "./packages/*" run build`).

### How the bridge works

- **page → native:** the page calls `window.__nt_ipc(json)`; the C core forwards
  the payload to the retained scriptc callback registered by `ntOnMessage`.
- **native → page:** compiled TS calls `ntEval(js)` to mutate the DOM.

This is the seed of the **DOM Host ABI** (Phase 1): today it's raw messages +
`eval`; next it becomes a batched DOM-op command buffer that both this webview
host and a future browser-wasm host implement.
