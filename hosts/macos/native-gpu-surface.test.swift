import AppKit
import QuartzCore

// Deterministic geometry / scheduler / lifecycle tests for NativeGPUSurface.swift.
// Run: hosts/macos/native-gpu-surface-test.sh (no GPU device, no window shown).

func check(_ ok: Bool, _ what: String, line: Int = #line) {
  if !ok { fatalError("FAIL line \(line): \(what)") }
}

final class FakeDriver {
  var link = false, turns = 0, ticks: [NativeGPUFrameTick] = [], linkChanges = 0
  var onTick: ((NativeGPUFrameTick) -> Void)?
  var driver: NativeGPUFrameScheduler.Driver {
    .init(
      setDisplayLinkActive: { [unowned self] on in link = on; linkChanges += 1 },
      scheduleTurn: { [unowned self] in turns += 1 },
      emit: { [unowned self] tick in ticks.append(tick); onTick?(tick) })
  }
}

func area(_ rects: [CGRect]) -> Double { rects.reduce(0) { $0 + $1.width * $1.height } }

func geometryTests() {
  let host = NativeGPUHostMetrics(viewport: CGSize(width: 1100, height: 760), backingScale: 2)
  // Full-viewport canvas at DPR 2: pixels and frame follow host.js pixels().
  var report = NativeGPUCanvasReport(rect: CGRect(x: 0, y: 0, width: 1100, height: 760), dpr: 2)
  var plan = NativeGPUSurfacePlan.make(report, host, composition: .overlay)
  check(plan.pixelWidth == 2200 && plan.pixelHeight == 1520, "dpr2 pixels")
  check(plan.frame == CGRect(x: 0, y: 0, width: 1100, height: 760) && plan.regionIsFullFrame, "full frame")
  check(plan.isVisible && plan.contentsScale == 2 && !plan.clamped, "visible")
  // Fractional CSS: round(css * dpr) like Math.round, frame snapped to device pixels.
  report.rect = CGRect(x: 10.3, y: 20.26, width: 300.25, height: 0.2)
  plan = NativeGPUSurfacePlan.make(report, host, composition: .overlay)
  check(plan.pixelWidth == 601 && plan.pixelHeight == 1, "rounding + min 1")
  check(plan.frame.minX == 10.5 && plan.frame.minY == 20.5 && plan.frame.maxX == 310.5, "snap \(plan.frame)")
  // DPR 1.5 (zoomed page on 1x... or fractional scaling)
  report.rect = CGRect(x: 0, y: 0, width: 101, height: 33)
  report.dpr = 1.5
  plan = NativeGPUSurfacePlan.make(report, host, composition: .overlay)
  check(plan.pixelWidth == 152 && plan.pixelHeight == 50, "dpr 1.5 rounding: \(plan.pixelWidth)x\(plan.pixelHeight)")
  // Page zoom: CSS px -> points; drawable keeps css*dpr.
  var zoomed = host
  zoomed.pageZoom = 1.25
  report = NativeGPUCanvasReport(rect: CGRect(x: 8, y: 8, width: 400, height: 200), dpr: 2.5)
  plan = NativeGPUSurfacePlan.make(report, zoomed, composition: .overlay)
  check(plan.frame == CGRect(x: 10, y: 10, width: 500, height: 250), "zoom frame \(plan.frame)")
  check(plan.pixelWidth == 1000 && plan.pixelHeight == 500, "zoom pixels")
  // fillsViewport follows host bounds (live resize) without a page report.
  var resized = zoomed
  resized.viewport = CGSize(width: 800, height: 600)
  report = NativeGPUCanvasReport(rect: .zero, dpr: 2.5, fillsViewport: true)
  plan = NativeGPUSurfacePlan.make(report, resized, composition: .overlay)
  check(plan.frame.size == CGSize(width: 800, height: 600) && plan.pixelWidth == 1600, "fillsViewport")
  // Uniform clamp to the device texture limit.
  var small = host
  small.maxDimension = 4096
  report = NativeGPUCanvasReport(rect: CGRect(x: 0, y: 0, width: 3000, height: 1000), dpr: 2)
  plan = NativeGPUSurfacePlan.make(report, small, composition: .overlay)
  check(plan.clamped && plan.pixelWidth == 4096 && plan.pixelHeight == 1365, "clamp \(plan.pixelWidth)x\(plan.pixelHeight)")
  // Partially off-viewport and ancestor clip.
  report = NativeGPUCanvasReport(
    rect: CGRect(x: -100, y: 700, width: 400, height: 200), dpr: 2,
    clip: CGRect(x: 0, y: 0, width: 250, height: 2000))
  plan = NativeGPUSurfacePlan.make(report, host, composition: .overlay)
  check(plan.region == [CGRect(x: 0, y: 700, width: 250, height: 60)] && !plan.regionIsFullFrame, "clip \(plan.region)")
  // Entirely outside / zero size / page hidden -> not visible, but still sized.
  report.rect = CGRect(x: 2000, y: 0, width: 10, height: 10)
  check(!NativeGPUSurfacePlan.make(report, host, composition: .overlay).isVisible, "offscreen")
  report = NativeGPUCanvasReport(rect: CGRect(x: 0, y: 0, width: 0, height: 0), dpr: 2)
  plan = NativeGPUSurfacePlan.make(report, host, composition: .overlay)
  check(!plan.isVisible && plan.pixelWidth == 1, "display:none canvas")
  report = NativeGPUCanvasReport(rect: CGRect(x: 0, y: 0, width: 50, height: 50), dpr: 2, pageVisible: false)
  check(!NativeGPUSurfacePlan.make(report, host, composition: .overlay).isVisible, "page hidden")
  // Overlay exclusions: snapped outward, disjoint pieces, exact area.
  report = NativeGPUCanvasReport(
    rect: CGRect(x: 0, y: 0, width: 1000, height: 700), dpr: 2,
    exclusions: [CGRect(x: 10.2, y: 10.2, width: 100, height: 40), CGRect(x: 900, y: 600, width: 200, height: 200)])
  plan = NativeGPUSurfacePlan.make(report, host, composition: .overlay)
  let cut1 = (110.5 - 10.0) * (50.5 - 10.0), cut2 = 100.0 * 100.0
  check(abs(area(plan.region) - (700_000 - cut1 - cut2)) < 1e-6, "exclusion area \(area(plan.region))")
  for (i, a) in plan.region.enumerated() {
    for b in plan.region[(i + 1)...] { check(a.intersection(b).isEmpty || a.intersection(b).isNull, "disjoint") }
  }
  // Underlay ignores exclusions (per-pixel DOM composition) when transparent.
  plan = NativeGPUSurfacePlan.make(report, host, composition: .underlay(webViewTransparent: true))
  check(plan.regionIsFullFrame, "underlay full")
  // Fallbacks.
  plan = NativeGPUSurfacePlan.make(report, host, composition: .underlay(webViewTransparent: false))
  check(plan.fallback == .transparentWebViewUnavailable && !plan.isVisible, "no transparent webview")
  var bad = report
  bad.axisAligned = false
  check(NativeGPUSurfacePlan.make(bad, host, composition: .overlay).fallback == .transformed, "transformed")
  bad = report
  bad.opaqueComposite = false
  check(NativeGPUSurfacePlan.make(bad, host, composition: .overlay).fallback == .translucent, "translucent")
  var pinch = host
  pinch.magnification = 1.5
  check(NativeGPUSurfacePlan.make(report, pinch, composition: .overlay).fallback == .magnified, "magnified")
  // A grid of exclusions explodes the region -> bounded fallback.
  var grid: [CGRect] = []
  for i in 0..<32 { grid.append(CGRect(x: 20 + Double(i) * 30, y: 20 + Double(i % 8) * 80, width: 5, height: 5)) }
  report.exclusions = grid
  plan = NativeGPUSurfacePlan.make(report, host, composition: .overlay)
  check(plan.fallback == .regionTooComplex || plan.region.count <= NativeGPUSurfacePlan.maxRegionRects, "bounded region")
  // Strict parsing of page messages.
  let ok = NativeGPUCanvasReport(message: [
    "x": 1, "y": 2, "width": 3, "height": 4, "dpr": 2, "visible": false, "revision": 7,
    "clip": ["x": 0, "y": 0, "width": 10, "height": 10], "exclusions": [["x": 0, "y": 0, "width": 1, "height": 1]],
  ] as [String: Any])
  check(ok?.rect == CGRect(x: 1, y: 2, width: 3, height: 4) && ok?.pageVisible == false && ok?.revision == 7, "parse")
  check(ok?.exclusions.count == 1 && ok?.clip?.width == 10, "parse nested")
  for broken: [String: Any] in [
    ["x": 1, "y": 2, "width": -3, "height": 4, "dpr": 2],
    ["x": 1, "y": 2, "width": 3, "height": 4, "dpr": 0],
    ["x": 1, "y": 2, "width": 3, "height": 4, "dpr": Double.nan],
    ["x": 1, "y": 2, "width": 3, "height": 4, "dpr": true],
    ["x": "1", "y": 2, "width": 3, "height": 4, "dpr": 2],
    ["x": 1, "y": 2, "width": 3, "height": 4, "dpr": 2, "visible": 1],
    ["x": 1, "y": 2, "width": 3, "height": 4, "dpr": 2, "revision": 1.5],
    ["x": 1, "y": 2, "width": 3, "height": 4, "dpr": 2, "exclusions": Array(repeating: ["x": 0, "y": 0, "width": 1, "height": 1], count: 33)],
  ] {
    check(NativeGPUCanvasReport(message: broken) == nil, "reject \(broken)")
  }
  check(NativeGPUCanvasReport(message: "nope") == nil, "reject non-object")
}

func schedulerTests() {
  // No request -> no ticks, no link, no turns.
  var fake = FakeDriver()
  var s = NativeGPUFrameScheduler(driver: fake.driver)
  s.setVisible(true)
  check(!fake.link && fake.turns == 0 && fake.ticks.isEmpty && s.idle, "idle without request")
  // Coalescing: many requests -> one link activation, one tick.
  for _ in 0..<10 { s.request() }
  check(fake.link && fake.ticks.isEmpty, "request never emits synchronously")
  s.displayTick(hostTime: 1, targetTime: 1.016)
  s.displayTick(hostTime: 1.016, targetTime: 1.033)
  check(fake.ticks.count == 1 && !fake.link && s.stats.linkActivations == 1, "coalesced")
  check(fake.ticks[0].targetTime == 1.016 && fake.ticks[0].presentable && fake.ticks[0].mode == .display, "tick fields")
  // Credit: maxInFlight 2 -> third request waits for a retire; link paused meanwhile.
  s.request(); s.displayTick(hostTime: 2, targetTime: 2)
  s.request()
  check(fake.ticks.count == 2 && !fake.link && !s.hasCredit, "credit exhausted pauses link")
  s.displayTick(hostTime: 3, targetTime: 3)
  check(fake.ticks.count == 2, "no tick without credit")
  s.retire(fake.ticks[0].token)
  check(fake.link, "retire resumes")
  s.displayTick(hostTime: 4, targetTime: 4)
  check(fake.ticks.count == 3, "tick after credit")
  s.retire(fake.ticks[0].token)
  check(s.stats.staleRetires == 1, "double retire ignored")
  // Hidden 'display' pauses and keeps the request.
  s.retire(fake.ticks[1].token); s.retire(fake.ticks[2].token)
  s.setVisible(false); s.request()
  check(!fake.link, "hidden display paused")
  s.setVisible(true)
  check(fake.link, "visible resumes pending request")
  // Device loss: request cancelled, credit restored, old tokens stale.
  s.displayTick(hostTime: 5, targetTime: 5)
  let before = fake.ticks.last!.token
  s.resetGeneration()
  check(s.inFlight.isEmpty && !s.requested && !fake.link, "reset")
  s.retire(before)
  check(s.stats.staleRetires == 2, "stale generation retire")
  // Mode switch keeps the request (gpu/host.js setFrameMode).
  s.request()
  s.setMode(.throughput)
  check(!fake.link && fake.turns == 1, "switch to throughput schedules a turn")
  for _ in 0..<5 { s.request() }
  check(fake.turns == 1, "turns coalesce")
  s.throughputTurn(hostTime: 6)
  check(fake.ticks.last!.mode == .throughput && fake.ticks.last!.targetTime == nil, "throughput tick")
  // Throughput is credit-bounded work rate.
  s.request(); s.throughputTurn(hostTime: 7)
  let count = fake.ticks.count
  s.request()
  check(fake.turns == 2 && !s.hasCredit, "no turn without credit")
  s.retire(fake.ticks[count - 1].token)
  check(fake.turns == 3, "retire schedules turn")
  // Hidden throughput still works but is non-presentable (default policy).
  s.setVisible(false)
  s.throughputTurn(hostTime: 8)
  check(fake.ticks.last!.presentable == false && fake.ticks.count == count + 1, "hidden throughput non-presentable")
  // Stale turn after switching back to display is ignored.
  s.retire(fake.ticks[count - 2].token); s.retire(fake.ticks.last!.token)
  s.request()
  let turns = fake.turns
  s.setMode(.display)
  s.throughputTurn(hostTime: 9)
  check(fake.ticks.count == count + 1 && fake.turns == turns, "stale turn ignored")
  // Dispose: nothing after.
  s.setVisible(true)
  check(fake.link, "display pending")
  s.dispose()
  check(!fake.link && s.idle, "dispose idles")
  s.request(); s.displayTick(hostTime: 10, targetTime: 10)
  check(fake.ticks.count == count + 1, "disposed emits nothing")

  // Display mode with 'throughputWhileHidden: false' variant.
  fake = FakeDriver()
  s = NativeGPUFrameScheduler(mode: .throughput, throughputWhileHidden: false, driver: fake.driver)
  s.request()
  check(fake.turns == 0, "hidden throughput suspended when policy off")
  s.setVisible(true)
  check(fake.turns == 1, "visible schedules")

  // Requesting from inside the tick sink only marks pending (no recursion).
  fake = FakeDriver()
  s = NativeGPUFrameScheduler(driver: fake.driver)
  let scheduler = s
  fake.onTick = { _ in scheduler.request() }
  s.setVisible(true)
  s.request()
  s.displayTick(hostTime: 1, targetTime: 1)
  check(fake.ticks.count == 1 && s.requested && fake.link, "request in tick defers to next vsync")
  s.displayTick(hostTime: 2, targetTime: 2)
  check(fake.ticks.count == 2, "next vsync")
  // credit 1
  fake = FakeDriver()
  s = NativeGPUFrameScheduler(mode: .throughput, maxInFlight: 1, driver: fake.driver)
  s.setVisible(true); s.request(); s.throughputTurn(hostTime: 0); s.request()
  check(fake.turns == 1 && fake.ticks.count == 1, "single credit")
}

@MainActor func appKitTests() {
  _ = NSApplication.shared
  let window = NSWindow(
    contentRect: CGRect(x: 0, y: 0, width: 640, height: 480), styleMask: [.titled],
    backing: .buffered, defer: false)
  window.isReleasedWhenClosed = false
  let container = NSView(frame: CGRect(x: 0, y: 0, width: 640, height: 480))
  window.contentView = container
  // Stand-in for WKWebView (no WebContent process in unit tests).
  final class Page: NSView { override var isFlipped: Bool { false } }
  let page = Page(frame: CGRect(x: 0, y: 40, width: 640, height: 440))
  container.addSubview(page)
  var events: [NativeGPUSurfaceEvent] = []
  let host = NativeGPUSurfaceHost(webView: page, composition: .overlay, mode: .throughput) { events.append($0) }
  var lease: NativeGPULayerLease!
  var viewRef: NativeGPUSurfaceView?
  autoreleasepool {
    host.attach()
    viewRef = host.view
    check(viewRef != nil, "attached")
    check(container.subviews.last === viewRef, "overlay above page")
    check(viewRef!.layer is CAMetalLayer && viewRef!.metalLayer.device == nil, "host never assigns a device")
    check(viewRef!.hitTest(CGPoint(x: 10, y: 10)) == nil, "input passes through")
    check(host.windowVisible == false, "unshown window is occluded")
    let scale = window.backingScaleFactor
    host.update(NativeGPUCanvasReport(rect: CGRect(x: 20, y: 10, width: 300, height: 200), dpr: Double(scale), revision: 1))
    // Page space y-down from page top (480 - 40 = 440 high) -> container y-up.
    check(viewRef!.frame == CGRect(x: 20, y: 40 + 440 - 210, width: 300, height: 200), "frame \(viewRef!.frame)")
    check(viewRef!.metalLayer.contentsScale == scale && viewRef!.metalLayer.mask == nil, "scale/mask")
    guard case .resize(let r)? = events.first(where: { if case .resize = $0 { return true } else { return false } })
    else { return check(false, "resize event") }
    check(r.width == Int(300 * scale) && r.height == Int(200 * scale), "resize dims")
    // Same geometry again: no duplicate RESIZE; stale revision ignored.
    let resizes = { events.filter { if case .resize = $0 { return true } else { return false } }.count }
    host.update(NativeGPUCanvasReport(rect: CGRect(x: 20, y: 10, width: 300, height: 200), dpr: Double(scale), revision: 2))
    host.update(NativeGPUCanvasReport(rect: CGRect(x: 0, y: 0, width: 10, height: 10), dpr: Double(scale), revision: 1))
    check(resizes() == 1, "deduped resize")
    // Exclusion -> mask in layer coordinates.
    host.update(NativeGPUCanvasReport(
      rect: CGRect(x: 20, y: 10, width: 300, height: 200), dpr: Double(scale),
      exclusions: [CGRect(x: 20, y: 10, width: 300, height: 50)], revision: 3))
    let mask = viewRef!.metalLayer.mask as? CAShapeLayer
    check(mask?.path?.boundingBoxOfPath == CGRect(x: 0, y: 0, width: 300, height: 150), "mask \(String(describing: mask?.path?.boundingBoxOfPath))")
    // Lease: single per generation, pointer is the layer, outlives teardown.
    lease = host.makeLease()!
    check(lease.layerPointer == Unmanaged.passUnretained(viewRef!.metalLayer).toOpaque(), "opaque pointer")
    check(host.makeLease() == nil, "one lease per generation")
    // Throughput while occluded: one non-presentable tick per request via the main queue.
    host.requestFrame(); host.requestFrame()
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline && !events.contains(where: { if case .frame = $0 { return true } else { return false } }) {
      RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
    for _ in 0..<5 { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
    let frames = events.compactMap { if case .frame(let t) = $0 { return t } else { return nil } }
    check(frames.count == 1 && frames[0].presentable == false, "one coalesced hidden tick: \(frames.count)")
    check(frames[0].surfaceRevision == 1, "tick carries revision")
    host.retire(frames[0].token)
  }
  weak var weakLayer: CAMetalLayer?
  weak var weakView: NativeGPUSurfaceView?
  weakView = viewRef
  autoreleasepool {
    weakLayer = viewRef!.metalLayer
    host.invalidate()
    check(viewRef!.superview == nil && host.view == nil, "view removed")
    viewRef = nil
  }
  guard case .invalidated(let g)? = events.last else { return check(false, "invalidated event") }
  check(g == lease.generation, "generation")
  host.requestFrame()
  for _ in 0..<5 { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
  check(events.filter { if case .frame = $0 { return true } else { return false } }.count == 1, "no ticks after teardown")
  CATransaction.flush()
  for _ in 0..<5 { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
  check(weakView == nil, "surface view freed at teardown")
  check(weakLayer != nil && !lease.isReleased, "lease keeps layer alive after teardown")
  autoreleasepool { lease.release(); lease.release() }
  CATransaction.flush()
  for _ in 0..<5 { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
  check(lease.isReleased, "released")
  check(weakLayer == nil, "layer freed after lease release")
  host.attach()
  check(host.view == nil, "torn-down host stays detached")
  // A second host: the executor may release its lease from its own thread;
  // the final CALayer release hops to the main thread.
  let second = NativeGPUSurfaceHost(webView: page, composition: .underlay(webViewTransparent: true)) { _ in }
  weak var secondLayer: CAMetalLayer?
  var secondLease: NativeGPULayerLease!
  autoreleasepool {
    second.attach()
    check(container.subviews.first === second.view, "underlay below page")
    secondLease = second.makeLease()
    secondLayer = second.view?.metalLayer
    second.invalidate()
  }
  let done = DispatchSemaphore(value: 0)
  Thread.detachNewThread { secondLease.release(); done.signal() }
  done.wait()
  check(secondLease.isReleased, "background release")
  for _ in 0..<5 { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
  CATransaction.flush()
  check(secondLayer == nil, "background-released layer freed on main")
  window.close()
}

@main struct NativeGPUSurfaceTests {
  @MainActor static func main() {
    geometryTests()
    schedulerTests()
    appKitTests()
    print("NT_NATIVE_GPU_SURFACE_PASS")
  }
}
