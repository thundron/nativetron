# In-page engine lane

The engine is a second wasm reactor inside the page, not a native process. Native retains windows, menus, dialogs and files. GPU batches and uploads remain in reactor memory; only bounded control messages cross the native bridge.

```sh
engine/build.sh
NT_ENGINE_SELFTEST=1 ./build/engine-desktop
node --test ipc/engine.test.mjs
node engine/browser-test.mjs
```

`engine/build.sh --web` builds the two reactors and stages the offline bundle without building the desktop executable. Serve the repository root and open `/engine/page.html`; `?main` explicitly exercises the main-thread fallback.

## Loader API

`startEngine({ canvas, moduleUrl, wasmUrl, prefix, report, postNative, postUi, onEvent, forceMain? })` returns a promise of `{ mode, reason, send(bytes, source?), dispose(), reactor }`. `mode` is `worker` or `main`. `reactor` is available only in main mode; applications must not depend on it. `send` validates the generated IPC frame and bounds control traffic to 60 messages/second. Source defaults to UI; native ingress must specify NATIVE. `dispose` stops scheduling and releases GPU resources.

The loader probes WebGPU, device creation, OffscreenCanvas context configuration and worker rAF before transferring the real canvas. Unsupported probes fall back to main. Startup failure after canvas transfer is reported, not silently replaced by a second renderer. Main-thread resize uses the GPU host's observer; worker resize and DPR changes are forwarded from the page without a polling loop.

The reactor exports `${prefix}start()`, `${prefix}frame(timeMs)`, `${prefix}event(type, requestId, handle, status, value, text)` and `${prefix}message(topic, bytes)`. Its host callbacks are `gpuPresent(batch, uploads, readbacks)`, `gpuReport(text)` and optional `engineSend(frameBytes)`. Capability text is the complete JSON capability object; shader text is the compilation-message array; resize text contains physical width/height, and value contains DPR. No promises, timers or browser objects enter compiled source. Outbound engine messages/reports and GPU events are delivered on later microtasks so a reply cannot reenter an active reactor callback.

The demo UI is independently compiled from `engine/ui.ts` and uses framework signals/components and the DOM Host ABI. UI commands reach the engine in-page (Worker postMessage or a direct reactor call); reports update the UI without native routing. The desktop native menu separately sends the same generated binary protocol through a base64-only fixed eval call. Its automated test invokes a real NSMenu item and waits for GPU submission completion after the colour change.

## Offline assets

`engine/package.mjs` stages an explicit allowlist under `build/engine-assets`; it never serves the repository or its `.git` directory. On macOS, an opt-in webview configuration hook installs `WKURLSchemeHandler` before WKWebView construction. It serves `app://local`, resolves symlinks, rejects paths outside the bundle, and supplies JavaScript/wasm MIME types. COOP/COEP response headers are optional; their presence does not guarantee that a custom origin becomes cross-origin isolated on every webview. Ordinary desktop builds keep their existing about:blank document and do not link the asset handler.

See [engine IPC](../ipc/ENGINE.md) for the exact generated description and codec.

## Verification

| host | evidence |
|---|---|
| Chrome, macOS arm64 | Worker preferred and forced-main fallback; compute/readback and compiled UI colour change pass |
| WKWebView, macOS 27.0.1 | Worker selected; 16 MiB upload, 4 KiB checked readback, timestamp and actual native-menu colour change pass |
| WKWebView, macOS 26 | not available on this machine; not verified |

The worker probe is capability-based, not an OS-version guess. No adapter produces a capability event and visible unavailable report.
