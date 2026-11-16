import AppKit
import QuartzCore

// Native presentation foundation for the macOS native GPU executor.
//
// This file owns presentation only: a CAMetalLayer-backed view placed next to
// the app's WKWebView, CSS canvas geometry -> native geometry, visibility and
// demand-driven frame pacing. It never creates an MTLDevice, never configures
// the layer for rendering and never calls a GPU API. The native executor (the
// wgpu-native lane) borrows the layer through `NativeGPULayerLease` and
// configures it through `wgpuSurfaceConfigure`.
//
// Contract mirrored from gpu/host.js + gpu/frame-scheduler.js:
// - `requestFrame` coalesces; one tick per request; no idle loop.
// - 'display' ticks follow the display link; 'throughput' ticks are a work
//   rate bounded by in-flight credit, not a promise of visible refresh.
// - RESIZE reports {width, height, dpr} with width = max(1, round(cssW * dpr)).
// - Callbacks only enqueue events to the reactor sink; nothing reenters the
//   guest synchronously from requestFrame/retire/geometry calls.
//
// See hosts/macos/README.md#experimental-native-gpu for ownership and integration.

// MARK: - Shared value types

enum NativeGPUFrameMode: String, Sendable {
  case display
  case throughput
}

/// How the native layer composes with the WKWebView.
enum NativeGPUComposition: Sendable, Equatable {
  /// Native view above the web view, masked to the visible canvas region minus
  /// page-reported DOM exclusion rects. Public AppKit API only. DOM over the
  /// canvas is rectangle-granular and shows the page (not the scene) behind it.
  case overlay
  /// Native view below a transparent web view: per-pixel DOM composition. On
  /// macOS no public API makes WKWebView non-opaque; the embedder must assert
  /// `webViewTransparent` itself (owner decision), otherwise the plan falls back.
  case underlay(webViewTransparent: Bool)
}

enum NativeGPUFallback: String, Sendable, Equatable {
  case transformed  // canvas or ancestor has rotate/skew/perspective
  case translucent  // opacity < 1, filter, blend mode or mask on the canvas path
  case magnified  // WKWebView magnification (pinch zoom) != 1
  case tooManyExclusions
  case regionTooComplex
  case transparentWebViewUnavailable
}

/// Page-reported canvas geometry, in CSS px relative to the WKWebView viewport
/// (`getBoundingClientRect()`), posted by the page on ResizeObserver / scroll /
/// DPR media-query change. Parsed strictly; untrusted page input.
struct NativeGPUCanvasReport: Equatable, Sendable {
  static let maxExclusions = 32
  var rect: CGRect
  var dpr: Double
  /// Visible part after ancestor overflow clipping (CSS px). nil = no clip.
  var clip: CGRect?
  /// DOM UI drawn over the canvas (CSS px); only used by `.overlay`.
  var exclusions: [CGRect] = []
  var axisAligned = true
  var opaqueComposite = true
  /// document.visibilityState === 'visible' and the canvas is rendered.
  var pageVisible = true
  /// The canvas is the whole viewport: the host derives the rect from the web
  /// view bounds so live window resize tracks without a page round trip.
  var fillsViewport = false
  var revision = 0

  init(
    rect: CGRect, dpr: Double, clip: CGRect? = nil, exclusions: [CGRect] = [],
    axisAligned: Bool = true, opaqueComposite: Bool = true, pageVisible: Bool = true,
    fillsViewport: Bool = false, revision: Int = 0
  ) {
    self.fillsViewport = fillsViewport
    self.rect = rect
    self.dpr = dpr
    self.clip = clip
    self.exclusions = exclusions
    self.axisAligned = axisAligned
    self.opaqueComposite = opaqueComposite
    self.pageVisible = pageVisible
    self.revision = revision
  }

  /// `{x,y,width,height,dpr,clip?:{x,y,width,height},exclusions?:[...],
  ///   axisAligned?,opaqueComposite?,visible?,fillsViewport?,revision?}`
  init?(message: Any) {
    guard let body = message as? [String: Any], let rect = Self.rect(body),
      let dpr = Self.number(body["dpr"]), dpr > 0, dpr <= 16
    else { return nil }
    self.rect = rect
    self.dpr = dpr
    if let clip = body["clip"] {
      guard let parsed = Self.rect(clip) else { return nil }
      self.clip = parsed
    }
    if let list = body["exclusions"] {
      guard let items = list as? [Any], items.count <= Self.maxExclusions else { return nil }
      var parsed: [CGRect] = []
      for item in items {
        guard let r = Self.rect(item) else { return nil }
        parsed.append(r)
      }
      exclusions = parsed
    }
    for (key, keyPath) in [
      ("axisAligned", \NativeGPUCanvasReport.axisAligned),
      ("opaqueComposite", \NativeGPUCanvasReport.opaqueComposite),
      ("visible", \NativeGPUCanvasReport.pageVisible),
      ("fillsViewport", \NativeGPUCanvasReport.fillsViewport),
    ] as [(String, WritableKeyPath<NativeGPUCanvasReport, Bool>)] {
      guard let value = body[key] else { continue }
      guard let flag = value as? Bool else { return nil }
      self[keyPath: keyPath] = flag
    }
    if let value = body["revision"] {
      guard let n = Self.number(value), n >= 0, n <= Double(Int32.max), n == n.rounded()
      else { return nil }
      revision = Int(n)
    }
  }

  private static let limit = 1 << 24
  private static func number(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let d = n.doubleValue
    return d.isFinite ? d : nil
  }
  private static func rect(_ value: Any) -> CGRect? {
    let body = value as? [String: Any] ?? [:]
    guard let x = number(body["x"]), let y = number(body["y"]), let w = number(body["width"]),
      let h = number(body["height"]), w >= 0, h >= 0,
      abs(x) < Double(limit), abs(y) < Double(limit), w < Double(limit), h < Double(limit)
    else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
  }
}

/// Host-side facts sampled on the main thread.
struct NativeGPUHostMetrics: Equatable, Sendable {
  /// WKWebView bounds in points.
  var viewport: CGSize
  /// NSWindow/NSScreen backingScaleFactor.
  var backingScale: Double
  /// WKWebView.pageZoom: CSS px -> points.
  var pageZoom: Double = 1
  /// WKWebView.magnification (pinch zoom). Not supported natively.
  var magnification: Double = 1
  /// Device maxTextureDimension2D; the executor lane supplies the real limit.
  var maxDimension = 8192
}

struct NativeGPUResize: Equatable, Sendable {
  var width: Int
  var height: Int
  var dpr: Double
  var clamped: Bool
  var revision: Int
}

/// Pure placement result. Coordinates are "page space": points, origin at the
/// web view's top-left, y down (the CSS axis scaled by pageZoom).
struct NativeGPUSurfacePlan: Equatable, Sendable {
  static let maxRegionRects = 256
  var frame: CGRect = .zero
  var contentsScale: Double = 1
  var pixelWidth = 1
  var pixelHeight = 1
  var dpr: Double = 1
  var clamped = false
  /// Visible parts of `frame` in page space; disjoint. Empty = nothing shown.
  var region: [CGRect] = []
  var fallback: NativeGPUFallback?
  var regionIsFullFrame: Bool { region.count == 1 && region[0] == frame }
  var isVisible: Bool { fallback == nil && !region.isEmpty }

  static func make(
    _ report: NativeGPUCanvasReport, _ host: NativeGPUHostMetrics,
    composition: NativeGPUComposition
  ) -> NativeGPUSurfacePlan {
    var plan = NativeGPUSurfacePlan()
    let zoom = max(host.pageZoom, 0.01)
    let scale = max(host.backingScale, 0.01)
    plan.contentsScale = scale
    plan.dpr = report.dpr
    var report = report
    if report.fillsViewport {
      report.rect = CGRect(
        x: 0, y: 0, width: host.viewport.width / zoom, height: host.viewport.height / zoom)
    }
    // Drawable pixels follow gpu/host.js pixels(): max(1, round(css * dpr)),
    // then a uniform clamp to the device texture limit.
    var pw = max(1, Int((report.rect.width * report.dpr).rounded()))
    var ph = max(1, Int((report.rect.height * report.dpr).rounded()))
    let limit = max(1, host.maxDimension)
    if pw > limit || ph > limit {
      let s = min(Double(limit) / Double(pw), Double(limit) / Double(ph))
      pw = min(limit, max(1, Int((Double(pw) * s).rounded(.down))))
      ph = min(limit, max(1, Int((Double(ph) * s).rounded(.down))))
      plan.clamped = true
    }
    plan.pixelWidth = pw
    plan.pixelHeight = ph
    plan.frame = snap(scaled(report.rect, zoom), scale)
    if !report.axisAligned { plan.fallback = .transformed }
    else if !report.opaqueComposite { plan.fallback = .translucent }
    else if abs(host.magnification - 1) > 1e-6 { plan.fallback = .magnified }
    else if case .underlay(false) = composition { plan.fallback = .transparentWebViewUnavailable }
    else if report.exclusions.count > NativeGPUCanvasReport.maxExclusions {
      plan.fallback = .tooManyExclusions
    }
    guard plan.fallback == nil, report.pageVisible else { return plan }
    var visible = plan.frame.intersection(CGRect(origin: .zero, size: host.viewport))
    if let clip = report.clip { visible = visible.intersection(snap(scaled(clip, zoom), scale)) }
    guard !visible.isNull, visible.width > 0, visible.height > 0 else { return plan }
    var region = [visible]
    if composition == .overlay {
      for cut in report.exclusions {
        let outward = snapOutward(scaled(cut, zoom), scale)
        region = region.flatMap { subtract($0, outward) }
        if region.count > maxRegionRects {
          plan.fallback = .regionTooComplex
          return plan
        }
      }
    }
    plan.region = region
    return plan
  }

  static func scaled(_ r: CGRect, _ k: Double) -> CGRect {
    CGRect(x: r.minX * k, y: r.minY * k, width: r.width * k, height: r.height * k)
  }
  /// Rounds edges to the device pixel grid so the layer is not resampled.
  static func snap(_ r: CGRect, _ scale: Double) -> CGRect {
    let x0 = (r.minX * scale).rounded() / scale, y0 = (r.minY * scale).rounded() / scale
    let x1 = (r.maxX * scale).rounded() / scale, y1 = (r.maxY * scale).rounded() / scale
    return CGRect(x: x0, y: y0, width: max(0, x1 - x0), height: max(0, y1 - y0))
  }
  /// Exclusions grow to whole pixels so DOM UI edges never show a scene seam.
  static func snapOutward(_ r: CGRect, _ scale: Double) -> CGRect {
    let x0 = (r.minX * scale).rounded(.down) / scale, y0 = (r.minY * scale).rounded(.down) / scale
    let x1 = (r.maxX * scale).rounded(.up) / scale, y1 = (r.maxY * scale).rounded(.up) / scale
    return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
  }
  static func subtract(_ r: CGRect, _ cut: CGRect) -> [CGRect] {
    let i = r.intersection(cut)
    guard !i.isNull, i.width > 0, i.height > 0 else { return [r] }
    var out: [CGRect] = []
    if i.minY > r.minY {
      out.append(CGRect(x: r.minX, y: r.minY, width: r.width, height: i.minY - r.minY))
    }
    if i.maxY < r.maxY {
      out.append(CGRect(x: r.minX, y: i.maxY, width: r.width, height: r.maxY - i.maxY))
    }
    if i.minX > r.minX {
      out.append(CGRect(x: r.minX, y: i.minY, width: i.minX - r.minX, height: i.height))
    }
    if i.maxX < r.maxX {
      out.append(CGRect(x: i.maxX, y: i.minY, width: r.maxX - i.maxX, height: i.height))
    }
    return out
  }
}

// MARK: - Demand-driven frame scheduler (pure, single-threaded)

struct NativeGPUFrameToken: Hashable, Sendable {
  var generation: UInt32
  var serial: UInt64
}

struct NativeGPUFrameTick: Equatable, Sendable {
  var token: NativeGPUFrameToken
  var mode: NativeGPUFrameMode
  /// CACurrentMediaTime() seconds. The integration maps it to the page's
  /// performance.now() timebase if the reactor stays in the page.
  var hostTime: Double
  /// Display link target presentation time ('display' only).
  var targetTime: Double?
  /// false: surface hidden/occluded. The executor must not acquire a drawable
  /// (nextDrawable may stall on an occluded layer); offscreen work and
  /// readbacks proceed. Only 'throughput' delivers non-presentable ticks.
  var presentable: Bool
  /// Geometry revision; the executor reconfigures when it differs from its own.
  var surfaceRevision: Int
}

/// Executes the frameMode contract with bounded drawable credit. Not thread
/// safe: the AppKit host drives it from the main thread only.
final class NativeGPUFrameScheduler {
  struct Driver {
    var setDisplayLinkActive: (Bool) -> Void
    /// Arrange exactly one later `throughputTurn` (never synchronously).
    var scheduleTurn: () -> Void
    /// Hand the tick to the reactor queue (never run guest code inline).
    var emit: (NativeGPUFrameTick) -> Void
  }
  struct Stats: Equatable { var ticks = 0, linkActivations = 0, turns = 0, staleRetires = 0 }

  let maxInFlight: Int
  /// 'throughput' keeps doing work while hidden (like the JS MessageChannel
  /// scheduler) but marks ticks non-presentable. 'display' always pauses.
  let throughputWhileHidden: Bool
  private(set) var mode: NativeGPUFrameMode
  private(set) var requested = false
  private(set) var visible = false
  private(set) var generation: UInt32 = 1
  private(set) var inFlight: Set<NativeGPUFrameToken> = []
  private(set) var displayLinkActive = false
  private(set) var turnScheduled = false
  private(set) var disposed = false
  private(set) var stats = Stats()
  var surfaceRevision = 0
  private var serial: UInt64 = 0
  private var emitting = false
  private let driver: Driver

  init(
    mode: NativeGPUFrameMode = .display, maxInFlight: Int = 2, throughputWhileHidden: Bool = true,
    driver: Driver
  ) {
    precondition(maxInFlight >= 1 && maxInFlight <= 3, "drawable credit must be 1...3")
    self.mode = mode
    self.maxInFlight = maxInFlight
    self.throughputWhileHidden = throughputWhileHidden
    self.driver = driver
  }

  var hasCredit: Bool { inFlight.count < maxInFlight }
  var idle: Bool { !requested && !displayLinkActive && !turnScheduled }

  func request() {
    guard !disposed else { return }
    requested = true
    pump()
  }
  func cancel() {
    requested = false
    pump()
  }
  func setMode(_ next: NativeGPUFrameMode) {
    guard !disposed, next != mode else { return }
    mode = next  // a pending request survives the switch, as in gpu/host.js
    pump()
  }
  func setVisible(_ value: Bool) {
    guard value != visible else { return }
    visible = value
    pump()
  }
  func displayTick(hostTime: Double, targetTime: Double) {
    guard !disposed, mode == .display, requested, visible, hasCredit else { return pump() }
    fire(hostTime: hostTime, targetTime: targetTime, presentable: true)
  }
  func throughputTurn(hostTime: Double) {
    turnScheduled = false
    stats.turns += 1
    guard !disposed, mode == .throughput, requested, hasCredit, visible || throughputWhileHidden
    else { return pump() }
    fire(hostTime: hostTime, targetTime: nil, presentable: visible)
  }
  /// The executor retires a tick when that frame's GPU work completed (or at
  /// once if the frame submitted nothing). Stale/unknown tokens are ignored.
  func retire(_ token: NativeGPUFrameToken) {
    guard token.generation == generation, inFlight.remove(token) != nil else {
      stats.staleRetires += 1
      return
    }
    pump()
  }
  /// Device loss / surface replacement: frame request cancelled, credit
  /// restored, outstanding tokens become stale (gpu/host.js loseDevice).
  func resetGeneration() {
    generation = generation == UInt32.max ? 1 : generation + 1
    inFlight.removeAll()
    requested = false
    pump()
  }
  func dispose() {
    guard !disposed else { return }
    disposed = true
    requested = false
    inFlight.removeAll()
    pump()
  }

  private func fire(hostTime: Double, targetTime: Double?, presentable: Bool) {
    precondition(!emitting, "frame tick reentered")
    requested = false
    serial &+= 1
    let token = NativeGPUFrameToken(generation: generation, serial: serial)
    inFlight.insert(token)
    stats.ticks += 1
    emitting = true
    driver.emit(
      NativeGPUFrameTick(
        token: token, mode: mode, hostTime: hostTime, targetTime: targetTime,
        presentable: presentable, surfaceRevision: surfaceRevision))
    emitting = false
    pump()
  }

  private func pump() {
    let link = !disposed && mode == .display && requested && visible && hasCredit
    if link != displayLinkActive {
      displayLinkActive = link
      if link { stats.linkActivations += 1 }
      driver.setDisplayLinkActive(link)
    }
    if !disposed, mode == .throughput, requested, hasCredit, visible || throughputWhileHidden,
      !turnScheduled
    {
      turnScheduled = true
      driver.scheduleTurn()
    }
  }
}

// MARK: - Opaque layer bridge

/// Borrowed CAMetalLayer for one surface generation, handed to the executor.
///
/// C bridge (wgpu-native, webgpu.h):
///   WGPUSurfaceSourceMetalLayer src = { .chain = { .sType =
///     WGPUSType_SurfaceSourceMetalLayer }, .layer = lease.layerPointer };
///   surface = wgpuInstanceCreateSurface(instance, &(WGPUSurfaceDescriptor){
///     .nextInChain = &src.chain });
///
/// Rules: the pointer is +0 and valid until `release()`; the lease keeps the
/// layer alive even after the host tears the view down. The executor calls
/// wgpuSurfaceUnconfigure + wgpuSurfaceRelease (after draining in-flight
/// frames) and only then `release()`. `release()` is idempotent and may be
/// called from any thread. The executor owns device, pixelFormat, colorspace,
/// framebufferOnly, drawableSize, maximumDrawableCount, displaySyncEnabled,
/// isOpaque and EDR via wgpuSurfaceConfigure; the host owns frame/bounds,
/// contentsScale, mask, hidden and z-order and never sets the executor's
/// properties.
final class NativeGPULayerLease: @unchecked Sendable {
  let generation: UInt32
  let layerPointer: UnsafeMutableRawPointer
  private let lock = NSLock()
  private var layer: CAMetalLayer?

  fileprivate init(layer: CAMetalLayer, generation: UInt32) {
    self.layer = layer
    self.generation = generation
    layerPointer = Unmanaged.passUnretained(layer).toOpaque()
  }
  var isReleased: Bool { lock.withLock { layer == nil } }
  func release() {
    let dropped: CAMetalLayer? = lock.withLock {
      defer { layer = nil }
      return layer
    }
    guard let dropped else { return }
    // Final CALayer release happens on the main thread.
    if Thread.isMainThread { withExtendedLifetime(dropped) {} } else {
      DispatchQueue.main.async { withExtendedLifetime(dropped) {} }
    }
  }
}

// MARK: - AppKit surface

/// Input-transparent, non-drawing view whose backing layer is a CAMetalLayer.
final class NativeGPUSurfaceView: NSView {
  var backingChanged: (() -> Void)?
  var windowChanged: (() -> Void)?
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layerContentsRedrawPolicy = .never
  }
  required init?(coder: NSCoder) { nil }
  override func makeBackingLayer() -> CALayer {
    let layer = CAMetalLayer()
    layer.backgroundColor = nil
    layer.allowsNextDrawableTimeout = true
    layer.actions = NativeGPUSurfaceView.noActions
    return layer
  }
  static let noActions: [String: CAAction] = [
    "bounds": NSNull(), "position": NSNull(), "frame": NSNull(), "contentsScale": NSNull(),
    "hidden": NSNull(), "mask": NSNull(), "contents": NSNull(), "sublayers": NSNull(),
  ]
  var metalLayer: CAMetalLayer { layer as! CAMetalLayer }
  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {}
  override var isOpaque: Bool { false }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }  // input stays in the page
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { false }
  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    backingChanged?()
  }
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    windowChanged?()
  }
}

enum NativeGPUSurfaceEvent: Sendable {
  case frame(NativeGPUFrameTick)
  case resize(NativeGPUResize)
  /// Native presentation became usable/unusable; on fallback the integration
  /// keeps (or returns to) the webview WebGPU executor.
  case presentation(visible: Bool, fallback: NativeGPUFallback?)
  /// Surface generation ended: the executor must release its WGPUSurface and
  /// then the lease.
  case invalidated(generation: UInt32)
}

/// Owns one CAMetalLayer surface aligned to a page canvas inside `webView`'s
/// superview. Main thread only. All outputs go through `enqueue`, which must
/// post to the reactor's queue and return immediately.
@MainActor
final class NativeGPUSurfaceHost {
  let composition: NativeGPUComposition
  private(set) var view: NativeGPUSurfaceView?
  private(set) var scheduler: NativeGPUFrameScheduler!
  private(set) var plan: NativeGPUSurfacePlan?
  private(set) var generation: UInt32 = 1
  private(set) var windowVisible = false
  private weak var webView: NSView?
  private var report: NativeGPUCanvasReport?
  private var lastResize: NativeGPUResize?
  private var lastPresentation: (Bool, NativeGPUFallback?)?
  private var link: CADisplayLink?
  private var linkProxy: NativeGPUDisplayLinkProxy?
  private var observers: [NSObjectProtocol] = []
  private var lease: NativeGPULayerLease?
  private var revision = 0
  private var invalidated = false
  private let enqueue: (NativeGPUSurfaceEvent) -> Void
  var magnification: () -> Double
  var pageZoom: () -> Double
  var maxDimension = 8192 { didSet { reapply() } }

  init(
    webView: NSView, composition: NativeGPUComposition, mode: NativeGPUFrameMode = .display,
    maxInFlight: Int = 2, pageZoom: @escaping () -> Double = { 1 },
    magnification: @escaping () -> Double = { 1 },
    enqueue: @escaping (NativeGPUSurfaceEvent) -> Void
  ) {
    self.webView = webView
    self.composition = composition
    self.enqueue = enqueue
    self.pageZoom = pageZoom
    self.magnification = magnification
    scheduler = NativeGPUFrameScheduler(
      mode: mode, maxInFlight: maxInFlight,
      driver: .init(
        setDisplayLinkActive: { [weak self] on in self?.link?.isPaused = !on },
        scheduleTurn: { [weak self] in
          DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.scheduler.throughputTurn(hostTime: CACurrentMediaTime()) }
          }
        },
        emit: { [weak self] tick in self?.enqueue(.frame(tick)) }))
  }

  /// Inserts the surface view next to `webView` (same superview) and starts
  /// observing window occlusion. The display link stays paused until a frame
  /// is requested.
  func attach() {
    // Single use: a torn-down host is never re-attached; make a new one.
    guard !invalidated, view == nil, let webView, let superview = webView.superview else { return }
    let surface = NativeGPUSurfaceView(frame: .zero)
    surface.isHidden = true
    switch composition {
    case .overlay: superview.addSubview(surface, positioned: .above, relativeTo: webView)
    case .underlay: superview.addSubview(surface, positioned: .below, relativeTo: webView)
    }
    surface.backingChanged = { [weak self] in self?.reapply() }
    surface.windowChanged = { [weak self] in self?.windowDidChange() }
    view = surface
    let proxy = NativeGPUDisplayLinkProxy()
    proxy.host = self
    linkProxy = proxy
    let link = surface.displayLink(target: proxy, selector: #selector(NativeGPUDisplayLinkProxy.tick(_:)))
    link.isPaused = true
    link.add(to: .main, forMode: .common)
    self.link = link
    scheduler.setVisible(false)
    for name in [NSView.frameDidChangeNotification, NSView.boundsDidChangeNotification] {
      observers.append(
        NotificationCenter.default.addObserver(forName: name, object: webView, queue: .main) {
          [weak self] _ in MainActor.assumeIsolated { self?.reapply() }
        })
    }
    observers.append(
      NotificationCenter.default.addObserver(
        forName: NSWindow.didChangeOcclusionStateNotification, object: nil, queue: .main
      ) { [weak self] note in
        MainActor.assumeIsolated {
          guard let self, (note.object as? NSWindow) === self.view?.window else { return }
          self.windowDidChange()
        }
      })
    windowDidChange()
  }

  /// One lease per generation. The executor creates its WGPUSurface from it.
  func makeLease() -> NativeGPULayerLease? {
    guard let view, lease.map({ $0.isReleased }) ?? true else { return nil }
    let made = NativeGPULayerLease(layer: view.metalLayer, generation: generation)
    lease = made
    return made
  }

  func update(_ next: NativeGPUCanvasReport) {
    guard view != nil, next.revision >= (report?.revision ?? 0) else { return }
    report = next
    reapply()
  }
  func requestFrame() { scheduler.request() }
  func cancelFrame() { scheduler.cancel() }
  func setFrameMode(_ mode: NativeGPUFrameMode) { scheduler.setMode(mode) }
  func retire(_ token: NativeGPUFrameToken) { scheduler.retire(token) }
  /// Device lost: cancels the request and restores credit; the layer stays.
  func deviceLost() { scheduler.resetGeneration() }

  /// Teardown. Removes the view and display link synchronously; the layer
  /// itself lives until the executor releases its lease.
  func invalidate() {
    guard view != nil else { return }
    invalidated = true
    scheduler.dispose()
    link?.invalidate()
    link = nil
    linkProxy = nil
    observers.forEach(NotificationCenter.default.removeObserver)
    observers.removeAll()
    view?.removeFromSuperview()
    view = nil
    let ended = generation
    generation = generation == UInt32.max ? 1 : generation + 1
    lease = nil  // the executor still holds its reference
    enqueue(.invalidated(generation: ended))
  }

  fileprivate func displayLinkFired(_ link: CADisplayLink) {
    scheduler.displayTick(hostTime: link.timestamp, targetTime: link.targetTimestamp)
  }

  private func windowDidChange() {
    let window = view?.window
    windowVisible = window.map { $0.occlusionState.contains(.visible) && !$0.isMiniaturized } ?? false
    reapply()
  }

  func metrics() -> NativeGPUHostMetrics? {
    guard let webView else { return nil }
    let scale = Double(view?.window?.backingScaleFactor ?? webView.window?.backingScaleFactor ?? 1)
    return NativeGPUHostMetrics(
      viewport: webView.bounds.size, backingScale: scale, pageZoom: pageZoom(),
      magnification: magnification(), maxDimension: maxDimension)
  }

  private func reapply() {
    guard let view, let webView, let superview = view.superview, let report,
      let metrics = metrics()
    else { return }
    let plan = NativeGPUSurfacePlan.make(report, metrics, composition: composition)
    let geometryChanged = plan != self.plan
    self.plan = plan
    if geometryChanged {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      let layer = view.metalLayer
      view.frame = webView.convert(local(plan.frame, in: webView), to: superview)
      layer.contentsScale = plan.contentsScale
      if plan.isVisible && !plan.regionIsFullFrame {
        let path = CGMutablePath()
        for rect in plan.region {
          path.addRect(view.convert(webView.convert(local(rect, in: webView), to: superview), from: superview))
        }
        let mask = CAShapeLayer()
        mask.actions = NativeGPUSurfaceView.noActions
        mask.path = path
        layer.mask = mask
      } else {
        layer.mask = nil
      }
      view.isHidden = !plan.isVisible
      CATransaction.commit()
    }
    let resize = NativeGPUResize(
      width: plan.pixelWidth, height: plan.pixelHeight, dpr: plan.dpr, clamped: plan.clamped,
      revision: revision)
    if lastResize.map({ $0.width != resize.width || $0.height != resize.height || $0.dpr != resize.dpr })
      ?? true
    {
      revision += 1
      scheduler.surfaceRevision = revision
      lastResize = NativeGPUResize(
        width: resize.width, height: resize.height, dpr: resize.dpr, clamped: resize.clamped,
        revision: revision)
      enqueue(.resize(lastResize!))
    }
    let presentation = (plan.isVisible && windowVisible, plan.fallback)
    if lastPresentation.map({ $0.0 != presentation.0 || $0.1 != presentation.1 }) ?? true {
      lastPresentation = presentation
      enqueue(.presentation(visible: presentation.0, fallback: presentation.1))
    }
    scheduler.setVisible(presentation.0)
  }

  /// Page space (y down from the web view's top-left) -> webView local.
  private func local(_ rect: CGRect, in webView: NSView) -> CGRect {
    webView.isFlipped
      ? rect
      : CGRect(x: rect.minX, y: webView.bounds.height - rect.maxY, width: rect.width, height: rect.height)
  }
}

/// CADisplayLink retains its target; the proxy breaks the cycle.
final class NativeGPUDisplayLinkProxy: NSObject {
  weak var host: NativeGPUSurfaceHost?
  @objc func tick(_ link: CADisplayLink) {
    MainActor.assumeIsolated { host?.displayLinkFired(link) }
  }
}
