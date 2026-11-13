# Native GPU presentation (macOS) — design notes

Status: integrated into the app (`build.sh`, `Main.swift`, `NativeGPUBridge.swift`); see [NATIVE-GPU-APP.md](NATIVE-GPU-APP.md) for flags, the executor wiring and the **measured** composition results (public API keeps WKWebView opaque; underlay needs private SPI and is quarantined behind `--native-gpu-composition=underlay-spi`). This file still owns presentation only: it creates no `MTLDevice`, never configures the layer for rendering and calls no GPU API.

Tests: `hosts/macos/native-gpu-surface-test.sh` typechecks the file for arm64 and x86_64 (Swift 5 with `-warnings-as-errors`, plus Swift 6), then builds and runs `native-gpu-surface.test.swift` in a private temp dir. It needs no GPU, window server presentation, signing or network. It prints `NT_NATIVE_GPU_SURFACE_PASS`.

## Pieces

| type | role | threading |
|---|---|---|
| `NativeGPUCanvasReport` | page → host canvas geometry, parsed strictly (untrusted) | value |
| `NativeGPUHostMetrics` | web-view bounds, backing scale, `pageZoom`, `magnification`, `maxDimension` | value |
| `NativeGPUSurfacePlan.make` | pure geometry: native frame, pixel size, visible region, fallback | pure |
| `NativeGPUFrameScheduler` | `'display'`/`'throughput'` state machine with bounded credit | main thread, pure |
| `NativeGPULayerLease` | opaque `CAMetalLayer*` borrowed by the executor for one generation | any thread |
| `NativeGPUSurfaceView` | input-transparent, non-drawing `NSView` backed by `CAMetalLayer` | main |
| `NativeGPUSurfaceHost` | owns the view, display link, occlusion/backing observers, lease and events | `@MainActor` |

Everything the host produces goes to `enqueue(NativeGPUSurfaceEvent)`: `.frame(tick)`, `.resize(width,height,dpr,clamped,revision)`, `.presentation(visible:fallback:)` and `.invalidated(generation:)`. `enqueue` **must** post to the reactor queue (or to the page with `evaluateJavaScript`) and return. It never runs guest code inline. `requestFrame`, `retire`, `update` and `setFrameMode` never emit a frame synchronously. Throughput turns use `DispatchQueue.main.async`. Display ticks come from the display link. A request made while a tick is being emitted is recorded as pending and served on the next turn or vsync. The scheduler asserts against reentrancy.

## Opaque CAMetalLayer bridge (ownership rules)

```c
WGPUSurfaceSourceMetalLayer src = { .chain = { .sType = WGPUSType_SurfaceSourceMetalLayer },
                                    .layer = lease.layerPointer };
WGPUSurfaceDescriptor desc = { .nextInChain = &src.chain };
WGPUSurface surface = wgpuInstanceCreateSurface(instance, &desc);
```

1. **Host owns the layer object.** `makeLease()` returns at most one live lease per generation. Its `layerPointer` is +0. It stays valid until the executor calls `lease.release()`, even after `invalidate()` removes the view. A test checks that the view is freed at teardown, the layer stays alive while the lease is held, and the layer is freed once the lease is released.
2. **Property partition.** The executor owns `device`, `pixelFormat`, `colorspace`, `framebufferOnly`, `drawableSize`, `maximumDrawableCount`, `displaySyncEnabled`, `isOpaque` and EDR, all through `wgpuSurfaceConfigure`. The host owns frame/bounds, `contentsScale`, `mask`, `isHidden` and z-order, and disables implicit animations. The host sets only `allowsNextDrawableTimeout = true` at creation. A probe showed that a backing `CAMetalLayer` does **not** auto-track `drawableSize` on resize, so the executor must reconfigure.
3. **Device is the executor's.** The host never assigns `layer.device`; a test checks that it is nil. wgpu's configure attaches its own device. Do not create a second `MTLDevice` for presentation.
4. **Reconfigure on revision.** Every RESIZE bumps `revision`. Each frame tick carries `surfaceRevision`. Before acquiring a texture, the executor calls `wgpuSurfaceConfigure(width,height)` from the latest `.resize` if its configured revision differs. It also reconfigures the present mode when `tick.mode` changes.
5. **Present mode mapping.** `'display'` maps to `Fifo`, which keeps `displaySyncEnabled = true`. `'throughput'` maps to `Immediate` (`displaySyncEnabled = false`) when the surface reports it. This gives uncapped presentation where macOS allows it. Otherwise it falls back to `Fifo` with credit pacing. Throughput is a work rate, not a promise of visible refresh.
6. **Teardown order.** On `.invalidated(generation)` the executor:
   1. stops acquiring;
   2. drains in-flight frames (at most `maxInFlight`);
   3. calls `wgpuSurfaceUnconfigure` and `wgpuSurfaceRelease`;
   4. calls `lease.release()`.

   `release()` is idempotent and thread-safe. The final `CALayer` release hops to the main thread; a test checks this from a background thread.
7. **Generations.** The host is single-use. After `invalidate()`, create a new host, which gives a new lease generation. `deviceLost()` bumps the scheduler generation, cancels the pending request and restores credit. It matches `loseDevice` in `gpu/host.js`. Retires of stale tokens are ignored and counted. The layer survives device loss, so make a new `WGPUSurface` from the same lease.

## Geometry

The page posts `{x,y,width,height,dpr,clip?,exclusions?,axisAligned?,opaqueComposite?,visible?,fillsViewport?,revision?}`. `x`, `y`, `width` and `height` come from `canvas.getBoundingClientRect()` in CSS px relative to the WKWebView viewport. The page posts on its ResizeObserver, scroll, DPR media query or `visibilitychange`.

- Drawable pixels match `pixels()` in `gpu/host.js`: `max(1, round(cssSize * dpr))`, using the page's `dpr`. The guest therefore sees the same RESIZE numbers as on the JS path. Duplicate `{width,height,dpr}` results are not re-emitted.
- If either pixel dimension exceeds `maxDimension` (the executor's `maxTextureDimension2D`), both are scaled down uniformly and RESIZE reports `clamped: true`. The JS host does not clamp. There, the WebGPU configure would fail instead.
- The native frame in points is `cssRect * pageZoom`, snapped to the device-pixel grid at `backingScaleFactor`. `contentsScale` is set to the backing scale.
- Page space (y down from the web view's top-left) is converted through `webView.isFlipped` and `convert(_:to:)`. This works for flipped and unflipped web views and for any superview.
- The visible region is: frame ∩ web-view bounds ∩ `clip`, minus `exclusions` (overlay only). Exclusions are snapped outward to whole pixels. The region is applied as a `CAShapeLayer` mask, or no mask when it covers the full frame.
- Limits: at most 32 exclusions (parser), and at most 256 region rects. Above that the plan returns a `regionTooComplex` fallback.
- `fillsViewport: true` derives the rect from the web-view bounds. Live window resize then tracks the native frame synchronously, with no page round trip.
- `.presentation(visible: false)` is sent in any of these cases:
  - zero size;
  - fully clipped;
  - `visible: false`, meaning the page is hidden or the canvas is not rendered;
  - the window is occluded or minimized (`NSWindow.occlusionState`).
- Backing scale changes, such as moving to another screen, re-plan through `viewDidChangeBackingProperties`. Web-view frame changes re-plan through frame/bounds notifications. The display link comes from `NSView.displayLink(target:selector:)` (macOS 14+), so it follows the view's screen automatically.

## Scheduling (`frameMode` contract)

- No request means nothing runs: the display link is paused, no turn is scheduled and no tick is emitted. This is tested.
- Requests coalesce. Each tick consumes the request. The guest must request again, as in `gpu/host.js`.
- **Credit.** `maxInFlight` (default 2, range 1…3, at or below `maximumDrawableCount - 1`) bounds the ticks whose GPU work has not retired. The integration calls `retire(token)` when the frame's queue work completes. Use `wgpuQueueOnSubmittedWorkDone` or the present callback, or retire immediately if the frame submitted nothing. Without credit, the display link pauses and throughput turns stop. A retire resumes them.
- `'display'`: one tick per display-link callback while requested, visible and in credit. `tick.targetTime` is the vsync target. Hidden means paused, and the request is kept.
- `'throughput'`: one main-queue turn per request while credit allows. While hidden, work continues (as with the JS `MessageChannel` scheduler) but `presentable: false`. On such ticks the executor must not call `getCurrentTexture`, because `nextDrawable` may stall on an occluded layer. Offscreen work and readbacks such as video export still run. Pass `throughputWhileHidden: false` to suspend instead.
- A mode switch keeps a pending request, like `setFrameMode` in `gpu/host.js`. A stale throughput turn after switching back to `'display'` is ignored.
- `hostTime` and `targetTime` are `CACurrentMediaTime()` seconds. If the reactor stays in the page Worker, the integration maps them to the page's `performance.now()` timebase.
- Low Power Mode and ProMotion: the display link's `preferredFrameRateRange` is left at the system default, so the OS may cap the rate. Read `HostPowerState` for the policy; the scheduler does not second-guess it.

## Composition with WKWebView (requirements and honest limits)

**Underlay** (`.underlay(webViewTransparent:)`) puts the native layer below the web view. DOM UI then composes per pixel over the scene. It requires a transparent WKWebView:

- **Page:** `html, body { background: transparent }`. No opaque ancestor may paint behind the canvas. The canvas itself must not get a `webgpu`/`2d` context; a canvas with no context is transparent.
- **Web view, macOS:** the SDK has **no public API** that makes `WKWebView` non-opaque. `underPageBackgroundColor` only affects the overscroll area. The common `setValue(false, forKey: "drawsBackground")` reaches WebKit SPI (`_setDrawsBackground:`) and is deliberately **not** used here. Unless the embedder asserts `webViewTransparent: true`, which is an owner decision on SPI, the plan returns `transparentWebViewUnavailable`.
- **Web view, iOS:** the public path is `isOpaque = false`, a clear `backgroundColor` and a clear `scrollView.backgroundColor`. The same plan code applies.

**Overlay** (`.overlay`, default, public API only) puts the native view above the web view. Hit-testing returns nil, so input stays in the page. The view is masked to the visible canvas region minus page-reported DOM exclusion rects. Limits:

- DOM over the canvas is rectangle-granular. Rounded, translucent or shadowed UI over the scene shows the page background behind it, not the scene.
- The page must report the rects of UI that floats over the canvas, such as menus and tooltips. Unreported UI is hidden under the scene.

**Both modes** are limited as follows:

- **Geometry lag.** Geometry follows page reports. Scroll and DOM layout changes reach the native frame one message hop later, so expect a frame of lag. `fillsViewport` avoids this for full-window canvases.
- **No transforms or compositing on the canvas path.** CSS transforms other than translate/scale (`axisAligned: false` → `transformed`), and opacity, filters, blend modes or masks (`opaqueComposite: false` → `translucent`), are not representable. These and WKWebView `magnification ≠ 1` (`magnified`) produce a fallback. Border-radius clipping is not representable either. It is a gap: no report field covers it, so the page must set `opaqueComposite: false` itself.
- **Fallback.** On `.presentation(_, fallback:)` the integration keeps the webview WebGPU executor. Native preferred, webview fallback, as in the brief.
- **Unsynchronized presentation.** `presentsWithTransaction` stays false. During live resize, scene and DOM can differ by about a frame. Transactional presentation would block the main thread and is not attempted.
- **Verified since** (NATIVE-GPU-APP.md): composited pixels of both modes via own-window capture, which needs no Screen Recording permission on the tested system. The colour-space match (sRGB vs Display P3) and EDR remain unverified.

## Integration (done, see NATIVE-GPU-APP.md)

The web view sits in a plain container view when a composition is selected; `NativeGPUSurfaceHost` is attached after the window exists, fed by the `ntGpuSurface` script message (main frame, page origin, ≤ 240/s), and its events go to `NativeGPUBridge.surfaceEvent` (ticks → TICK frames, resize → executor resize + RESIZE event, presentation → evidence). The executor gets `lease.layerPointer` as `NtGpuExecutorOptions.metal_layer`; the generation's queue destroys the executor and then releases the lease. `invalidate()` runs before page disposal on window close.

## Not done here

- Presentation fallback only logs; it does not switch an executing generation back to WebGPU.
- No ProMotion, Low Power Mode or display-link timing measurements (deferred).
- No iOS `UIView` twin.
