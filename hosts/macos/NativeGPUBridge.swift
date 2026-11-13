import AppKit
import Foundation
import QuartzCore
@preconcurrency import WebKit

// Native GPU binary channel for the macOS host. The engine Worker talks to it with plain `fetch` on the
// page's own `app://` origin, routed by MacSchemeRouter to `/__ntgpu/`:
//   POST session            page claims the per-load capability (once per navigation)
//   GET  ping               Worker probe (capability required)
//   POST post?engine=&b=    upstream frames (engine/native-gpu-wire.js), bounded bodies, reordered by `b`
//   GET  poll?engine=       downstream long-poll: held while idle, answered (one write + didFinish) with every
//                           queued frame as soon as one exists. A long-lived streamed response is not used:
//                           WebKit withholds WKURLSchemeTask writes that follow another write within a few ms.
//   GET  stats              instrumentation snapshot (capability required)
// No loopback socket, no ATS/CSP/CORS change and no base64. Executor calls are serialized on one queue per
// engine generation; executor callbacks only enqueue frames (never re-enter the guest, which lives in the
// Worker anyway). Submissions are acknowledged only after ntgpu_executor_submit consumed the whole batch.

/// Function table for gpu/native/executor.h (linked artifact or unlinked stub) or the test recorder.
struct NativeGPUExecutorAPI: @unchecked Sendable {
  let name: String
  let create: (UnsafePointer<NtGpuExecutorOptions>, UnsafeMutablePointer<OpaquePointer?>) -> Int32
  let destroy: (OpaquePointer) -> Void
  let submit: (OpaquePointer, UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int, Int) -> Int32
  let process: (OpaquePointer) -> Void
  let resize: (OpaquePointer, UInt32, UInt32, Double) -> Void
  let capture: (OpaquePointer, UnsafeMutablePointer<UInt8>, Int, UnsafeMutablePointer<UInt32>, UnsafeMutablePointer<UInt32>) -> Int32

  static let linkage = String(cString: nt_macos_gpu_executor_linkage())
  static let executor = NativeGPUExecutorAPI(
    name: linkage, create: { ntgpu_executor_create($0, $1) }, destroy: { ntgpu_executor_destroy($0) },
    submit: { ntgpu_executor_submit($0, $1, $2, $3, $4, $5) }, process: { ntgpu_executor_process($0) },
    resize: { ntgpu_executor_resize($0, $1, $2, $3) },
    capture: { ntgpu_executor_capture_rgba($0, $1, $2, $3, $4) })
  static let recorder = NativeGPUExecutorAPI(
    name: "recorder", create: { nt_recorder_executor_create($0, $1) },
    destroy: { nt_recorder_executor_destroy($0) },
    submit: { nt_recorder_executor_submit($0, $1, $2, $3, $4, $5) },
    process: { nt_recorder_executor_process($0) },
    resize: { nt_recorder_executor_resize($0, $1, $2, $3) },
    capture: { nt_recorder_executor_capture_rgba($0, $1, $2, $3, $4) })
}

/// Thread-safe counters for later measurement runs (bytes, copies, latency). No timing claims are made here.
final class NativeGPUStats: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: Double] = [:]
  func add(_ key: String, _ value: Double = 1) { lock.withLock { values[key, default: 0] += value } }
  func max(_ key: String, _ value: Double) { lock.withLock { values[key] = Swift.max(values[key] ?? 0, value) } }
  func snapshot() -> [String: Double] { lock.withLock { values } }
  func reset() { lock.withLock { values.removeAll() } }
}

/// A WKURLSchemeTask that may be stopped by WebKit at any time; every use checks `live` (main thread).
@MainActor final class NativeGPUTask {
  let task: WKURLSchemeTask
  var live = true
  init(_ task: WKURLSchemeTask) { self.task = task }
  func respond(_ status: Int, type: String = "text/plain", body: Data = Data(), finish: Bool = true) {
    guard live, let url = task.request.url else { return }
    let headers = [
      "Content-Type": type, "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    ]
    guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
    else { return }
    task.didReceive(response)
    if !body.isEmpty { task.didReceive(body) }
    if finish { task.didFinish(); live = false }
  }
  func write(_ data: Data) { if live, !data.isEmpty { task.didReceive(data) } }
  func finish() { if live { task.didFinish(); live = false } }
}

struct NativeGPUBridgeOptions {
  var api = NativeGPUExecutorAPI.executor
  var composition = "none"  // "underlay" | "overlay" | "none" (headless execution, no presentation)
  var maxEngines = 2
  var maxReorderBodies = 8
  var maxDownstreamBytes = 96 * 1_048_576
}

@MainActor final class NativeGPUBridge {
  static let prefix = "/__ntgpu/"
  let options: NativeGPUBridgeOptions
  let stats = NativeGPUStats()
  var surface: NativeGPUSurfaceHost?
  /// Latest drawable size (from the surface plan or, headless, from page geometry).
  private(set) var size: (width: Int, height: Int, dpr: Double) = (64, 64, 1)
  /// A real size arrived (page geometry or surface plan); until then the executor uses the headless default.
  private(set) var sizeKnown = false
  private var token: String?
  private var claimed = false
  private var origin: (scheme: String, host: String)?
  private var engines: [UInt32: NativeGPUEngineChannel] = [:]
  private var retiredThrough: UInt32 = 0
  private var tasks: [ObjectIdentifier: NativeGPUTask] = [:]
  var onLog: (String, String) -> Void = { Evidence.emit($0, $1) }
  /// Test-only routes (wire self-test page). Empty in normal runs.
  var testRoutes: [String: (type: String, body: Data)] = [:]

  init(options: NativeGPUBridgeOptions) { self.options = options }

  /// Page (re)navigation or content-process loss: every generation and capability of the old page ends.
  func reset(origin next: URL?) {
    for engine in engines.values { engine.close("page navigated", notify: false) }
    engines.removeAll()
    for task in tasks.values where task.live { task.respond(410, body: Data("native GPU session ended".utf8)) }
    tasks.removeAll()
    retiredThrough = 0
    claimed = false
    token = Self.makeToken()
    origin = next.flatMap { url in url.scheme.flatMap { s in url.host.map { (s, $0) } } }
  }

  private static func makeToken() -> String? {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  func handles(_ url: URL?) -> Bool { url?.path.hasPrefix(Self.prefix) ?? false }

  // MARK: scheme tasks (main thread)

  func start(_ raw: WKURLSchemeTask) {
    let task = NativeGPUTask(raw)
    let request = raw.request
    guard let url = request.url, let origin, url.scheme == origin.scheme, url.host == origin.host else {
      task.respond(403, body: Data("native GPU endpoint is bound to the page origin".utf8)); return
    }
    // Same-origin only: a non-GET from WebKit carries Origin; anything else is refused.
    if let from = request.value(forHTTPHeaderField: "Origin"), from != "\(origin.scheme)://\(origin.host)" {
      task.respond(403, body: Data("cross-origin native GPU request refused".utf8)); return
    }
    let route = String(url.path.dropFirst(Self.prefix.count))
    let method = request.httpMethod ?? "GET"
    if let test = testRoutes[route], method == "GET" { task.respond(200, type: test.type, body: test.body); return }
    if route == "session" {
      guard method == "POST", !claimed, let token else {
        task.respond(409, body: Data("native GPU session already claimed for this page".utf8)); return
      }
      claimed = true
      let info: [String: Any] = [
        "session": token, "executor": options.api.name, "composition": options.composition,
        "presentation": surface != nil, "wire": 1,
      ]
      task.respond(200, type: "application/json", body: (try? JSONSerialization.data(withJSONObject: info)) ?? Data())
      onLog("NT_MACOS_NATIVE_GPU_SESSION", "executor=\(options.api.name) composition=\(options.composition)")
      return
    }
    guard let token, claimed, request.value(forHTTPHeaderField: "X-NT-GPU-Session") == token else {
      task.respond(401, body: Data("native GPU capability required".utf8)); return
    }
    let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let item = { (name: String) in query.first { $0.name == name }?.value }
    switch (method, route) {
    case ("GET", "ping"):
      task.respond(200, type: "application/json", body: Data("{\"executor\":\"\(options.api.name)\",\"wire\":1}".utf8))
    case ("GET", "stats"):
      var snapshot: [String: Any] = stats.snapshot()
      snapshot["executor"] = options.api.name
      task.respond(200, type: "application/json", body: (try? JSONSerialization.data(withJSONObject: snapshot)) ?? Data())
    case ("GET", "poll"), ("POST", "post"):
      guard let text = item("engine"), let id = UInt32(text), id > 0 else { task.respond(400); return }
      guard let engine = channel(id) else {
        let why = engines[id]?.closeReason ?? "retired"
        task.respond(410, body: Data("native GPU engine generation \(id) ended: \(why)".utf8)); return
      }
      if route == "poll" { tasks[ObjectIdentifier(raw)] = task; engine.attach(task); return }
      guard let body = Self.body(request) else { task.respond(413, body: Data("native GPU body too large or missing".utf8)); return }
      stats.add("bodies"); stats.add("bodyBytes", Double(body.count)); stats.max("maxBodyBytes", Double(body.count))
      if item("b") == "close" {
        engine.close("closed by page", notify: false); engines[id] = nil
        retiredThrough = max(retiredThrough, id)
        task.respond(204); return
      }
      guard let seq = item("b").flatMap(UInt32.init), seq > 0 else { task.respond(400); return }
      tasks[ObjectIdentifier(raw)] = task
      engine.receive(body: body, sequence: seq, task: task)
    default:
      task.respond(404)
    }
  }

  func stop(_ raw: WKURLSchemeTask) {
    if let task = tasks.removeValue(forKey: ObjectIdentifier(raw)) { task.live = false }
  }
  func forget(_ task: NativeGPUTask) { tasks.removeValue(forKey: ObjectIdentifier(task.task)) }

  private static func body(_ request: URLRequest) -> Data? {
    if let data = request.httpBody { return data.count <= NativeGPUWire.maxBodyBytes ? data : nil }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open(); defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = stream.read(&buffer, maxLength: buffer.count)
      if n < 0 { return nil }
      if n == 0 { return data }
      if data.count + n > NativeGPUWire.maxBodyBytes { return nil }
      data.append(buffer, count: n)
    }
  }

  /// Engine generations only move forward: a request for a retired generation gets 410; a new one retires
  /// every older generation (the Worker restarted its reactor).
  private func channel(_ id: UInt32) -> NativeGPUEngineChannel? {
    if let engine = engines[id] { return engine.closed ? nil : engine }
    guard id > retiredThrough else { return nil }
    for (old, engine) in engines where old < id { engine.close("superseded by generation \(id)", notify: true); engines[old] = nil }
    retiredThrough = max(retiredThrough, id - 1)
    guard engines.count < options.maxEngines else { return nil }
    let engine = NativeGPUEngineChannel(id: id, bridge: self)
    engines[id] = engine
    stats.add("engines")
    return engine
  }

  var active: NativeGPUEngineChannel? { engines.values.filter { !$0.closed }.max { $0.id < $1.id } }

  // MARK: presentation and geometry (main thread)

  /// Page canvas geometry (ntGpuSurface script message). With a surface the plan decides the drawable size;
  /// headless, the size follows gpu/host.js pixels(): max(1, round(css * dpr)).
  func geometry(_ body: Any) {
    guard let report = NativeGPUCanvasReport(message: body) else { stats.add("geometryRejected"); return }
    if let surface { surface.update(report); return }
    let width = max(1, Int((report.rect.width * report.dpr).rounded()))
    let height = max(1, Int((report.rect.height * report.dpr).rounded()))
    resized(width: min(width, 8192), height: min(height, 8192), dpr: report.dpr)
  }

  func surfaceEvent(_ event: NativeGPUSurfaceEvent) {
    switch event {
    case .frame(let tick):
      // Credit is held by the JS host until acknowledgement; the surface credit is returned on the next turn.
      DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.surface?.retire(tick.token) } }
      active?.deliverTicks(hostTime: tick.hostTime)
    case .resize(let resize): resized(width: resize.width, height: resize.height, dpr: resize.dpr)
    case .presentation(let visible, let fallback):
      stats.add(visible ? "presentationVisible" : "presentationHidden")
      onLog("NT_MACOS_NATIVE_GPU_PRESENTATION", "visible=\(visible) fallback=\(fallback?.rawValue ?? "none")")
    case .invalidated(let generation):
      onLog("NT_MACOS_NATIVE_GPU_SURFACE_INVALIDATED", "\(generation)")
    }
  }

  private func resized(width: Int, height: Int, dpr: Double) {
    guard !sizeKnown || width != size.width || height != size.height || dpr != size.dpr else { return }
    size = (width, height, dpr)
    sizeKnown = true
    stats.add("resizes")
    active?.resize(width: width, height: height, dpr: dpr)
  }

  private var leaseWaiters: [() -> Bool] = []
  /// Called when a lease may be available again (previous executor destroyed).
  func waitForLease(_ retry: @escaping () -> Bool) { leaseWaiters.append(retry) }
  func leaseReleased() {
    let waiting = leaseWaiters
    leaseWaiters.removeAll()
    for retry in waiting where !retry() {}
  }

  func shutdown() {
    reset(origin: nil)
    token = nil
  }
}

/// One-shot handoff of the layer pointer from the main thread to an engine queue.
final class LeaseGate: @unchecked Sendable {
  private let semaphore = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var layer: UnsafeMutableRawPointer?
  private var opened = false
  func open(_ value: UnsafeMutableRawPointer?) {
    let first: Bool = lock.withLock { if opened { return false }; opened = true; layer = value; return true }
    if first { semaphore.signal() }
  }
  func wait(seconds: Double) -> UnsafeMutableRawPointer? {
    _ = semaphore.wait(timeout: .now() + seconds)
    return lock.withLock { opened = true; return layer }
  }
}

/// One engine generation: upstream reassembly, executor ownership and the downstream stream.
final class NativeGPUEngineChannel: @unchecked Sendable {
  let id: UInt32
  private unowned(unsafe) let bridgeRef: NativeGPUBridge
  private let api: NativeGPUExecutorAPI
  private let stats: NativeGPUStats
  private let queue: DispatchQueue
  private let maxDownstreamBytes: Int
  // main thread
  @MainActor private(set) var closed = false
  @MainActor private(set) var closeReason = ""
  @MainActor private var stream: NativeGPUTask?
  @MainActor private var reorder: [UInt32: (Data, NativeGPUTask)] = [:]
  @MainActor private var expectedBody: UInt32 = 1
  @MainActor private var opened = false
  @MainActor private var throughput = false
  @MainActor private var ticks: [UInt32: Double] = [:]
  @MainActor private var headlessTick = false
  @MainActor private var lease: NativeGPULayerLease?
  // executor queue
  private var executor: OpaquePointer?
  private var limits = (commands: 0, uploads: 0, readbacks: 0, chunk: 0)
  private var assembly: Assembly?
  private var lastSequence: UInt32 = 0
  private var queueFailed = false
  // shared (lock)
  private let lock = NSLock()
  private var outbox = Data()
  private var flushScheduled = false
  private var wakeScheduled = false
  private var device: UInt32 = 0
  private var downstreamFailed = false

  private struct Section {
    var total: Int, received = 0
    var single: Data?
    var buffer: Data?
    var complete: Bool { received == total }
    mutating func take(_ bytes: Data, at offset: Int, stats: NativeGPUStats) -> Bool {
      guard offset == received, bytes.count <= total - received else { return false }
      if offset == 0 && bytes.count == total { single = bytes } else {
        if buffer == nil { buffer = Data(count: total) }
        buffer!.withUnsafeMutableBytes { dst in
          bytes.withUnsafeBytes { src in dst.baseAddress!.advanced(by: offset).copyMemory(from: src.baseAddress!, byteCount: src.count) }
        }
        stats.add("reassemblyCopies"); stats.add("reassemblyBytes", Double(bytes.count))
      }
      received += bytes.count
      return true
    }
    var bytes: Data { single ?? buffer ?? Data() }
  }
  private struct Assembly {
    var sequence: UInt32, chunks: Int, next = 1, readbacks: Int
    var commands: Section, uploads: Section
  }

  @MainActor init(id: UInt32, bridge: NativeGPUBridge) {
    self.id = id
    bridgeRef = bridge
    api = bridge.options.api
    stats = bridge.stats
    queue = DispatchQueue(label: "dev.nativetron.gpu.engine.\(id)", qos: .userInteractive)
    maxDownstreamBytes = bridge.options.maxDownstreamBytes
  }
  @MainActor private var bridge: NativeGPUBridge { bridgeRef }

  // MARK: downstream (any thread)

  private func emit(_ build: (inout Data, UInt32) -> Void) {
    let schedule: Bool = lock.withLock {
      guard !downstreamFailed else { return false }
      build(&outbox, device)
      if outbox.count > maxDownstreamBytes { downstreamFailed = true }
      if flushScheduled { return false }
      flushScheduled = true
      return true
    }
    if schedule { DispatchQueue.main.async { MainActor.assumeIsolated { self.flush() } } }
  }
  private func emitFrame(_ kind: NativeGPUWire.Kind, sequence: UInt32 = 0, a: UInt32? = nil, b: UInt32 = 0, c: UInt32 = 0, payload: Data = Data()) {
    emit { out, device in
      payload.withUnsafeBytes { raw in
        NativeGPUWire.append(&out, kind: kind, engine: id, sequence: sequence, a: a ?? device, b: b, c: c, payload: raw)
      }
    }
    stats.add("downFrames")
  }

  @MainActor private func flush() {
    let (data, overflow): (Data, Bool) = lock.withLock {
      flushScheduled = false
      guard stream?.live == true || downstreamFailed else { return (Data(), false) }
      defer { outbox = Data() }
      return (outbox, downstreamFailed)
    }
    if overflow { fail("native GPU downstream queue exhausted"); return }
    guard let stream, stream.live, !data.isEmpty else { return }
    // One write, then finish: the Worker re-polls at once. Frames queue (bounded) while no poll is held.
    stream.respond(200, type: "application/octet-stream", body: data)
    bridge.forget(stream)
    self.stream = nil
    stats.add("downBytes", Double(data.count)); stats.add("downWrites"); stats.max("downMaxWrite", Double(data.count))
  }

  @MainActor func attach(_ task: NativeGPUTask) {
    guard stream?.live != true else {
      task.respond(409, body: Data("native GPU poll already outstanding".utf8)); bridge.forget(task); return
    }
    stream = task
    stats.add("polls")
    lock.withLock { flushScheduled = true }
    flush()
  }

  // MARK: upstream (main → queue)

  @MainActor func receive(body: Data, sequence: UInt32, task: NativeGPUTask) {
    guard !closed else { task.respond(410); bridge.forget(task); return }
    guard sequence >= expectedBody, reorder[sequence] == nil, reorder.count < bridge.options.maxReorderBodies else {
      task.respond(409, body: Data("native GPU body sequence violation".utf8)); bridge.forget(task)
      fail("native GPU body sequence violation (\(sequence), expected \(expectedBody))"); return
    }
    reorder[sequence] = (body, task)
    if sequence != expectedBody { stats.add("reorderedBodies") }
    while let entry = reorder.removeValue(forKey: expectedBody) {
      let (next, waiting) = entry
      expectedBody += 1
      let frames: [NativeGPUWire.Frame]
      do { frames = try NativeGPUWire.parseUpstream(next) } catch {
        waiting.respond(400, body: Data("malformed native GPU body: \(error)".utf8)); bridge.forget(waiting)
        fail("malformed native GPU body: \(error)"); return
      }
      if frames.contains(where: { $0.header.engine != id }) {
        waiting.respond(400); bridge.forget(waiting); fail("native GPU frame for another engine"); return
      }
      for frame in frames { mainFrame(frame) }
      guard !closed else { waiting.respond(410); bridge.forget(waiting); return }
      // The body is answered once the executor queue consumed it: this is the transport's backpressure.
      let queued = frames.filter { [.open, .submit, .chunk].contains(NativeGPUWire.Kind(rawValue: $0.header.kind)) }
      let received = CACurrentMediaTime()
      queue.async { [self] in
        for frame in queued where !queueFailed { queueFrame(frame) }
        let ms = (CACurrentMediaTime() - received) * 1000
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            self.stats.add("bodyQueueMs", ms); self.stats.max("bodyQueueMaxMs", ms)
            waiting.respond(204); self.bridge.forget(waiting)
          }
        }
      }
    }
  }

  /// Frames that touch presentation state run on the main thread, in body order.
  @MainActor private func mainFrame(_ frame: NativeGPUWire.Frame) {
    let h = frame.header
    switch NativeGPUWire.Kind(rawValue: h.kind) {
    case .open:
      guard !opened else { fail("native GPU engine opened twice"); return }
      opened = true
      throughput = h.flags & NativeGPUWire.flagThroughput != 0
      let size = bridge.size
      // Like gpu/host.js, every new host instance first sees the current drawable size.
      if bridge.sizeKnown { resizeEvent(width: size.width, height: size.height, dpr: size.dpr) }
      guard let surface = bridge.surface else {
        queue.async { [self] in createExecutor(layer: nil, width: size.width, height: size.height, dpr: size.dpr) }
        return
      }
      surface.setFrameMode(throughput ? .throughput : .display)
      if let made = surface.makeLease() {
        lease = made
        let layer = UInt(bitPattern: made.layerPointer)
        queue.async { [self] in createExecutor(layer: UnsafeMutableRawPointer(bitPattern: layer), width: size.width, height: size.height, dpr: size.dpr) }
        return
      }
      // The previous generation's executor still holds the layer: its queue releases the lease after destroy.
      // This engine's queue waits (bounded) before anything else it would run, so frames stay ordered.
      let gate = LeaseGate()
      bridge.waitForLease { [weak self] in
        guard let self, !self.closed, let made = self.bridge.surface?.makeLease() else { gate.open(nil); return false }
        self.lease = made
        gate.open(made.layerPointer)
        return true
      }
      queue.async { [self] in
        let layer = gate.wait(seconds: 3)
        if layer == nil { stats.add("leaseWaitTimeouts") }
        createExecutor(layer: layer, width: size.width, height: size.height, dpr: size.dpr)
      }
    case .frameMode:
      throughput = h.a == 1
      if isPresenter { bridge.surface?.setFrameMode(throughput ? .throughput : .display) }
    case .tickRequest:
      ticks[h.a] = CACurrentMediaTime()
      stats.add("tickRequests")
      if isPresenter, let surface = bridge.surface { surface.requestFrame() } else { armHeadlessTick() }
    case .tickCancel:
      ticks[h.a] = nil
      if ticks.isEmpty, isPresenter { bridge.surface?.cancelFrame() }
    case .close: close("closed by page", notify: false)
    default: break
    }
  }

  @MainActor private var isPresenter: Bool { lease != nil && bridge.active === self }

  /// Headless pacing (no CAMetalLayer): one main-queue turn per request, ~60 Hz in 'display'. Armed only while
  /// a request is outstanding; nothing runs while idle.
  @MainActor private func armHeadlessTick() {
    guard !headlessTick else { return }
    headlessTick = true
    let deliver: @Sendable () -> Void = { [weak self] in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.headlessTick = false
        self.deliverTicks(hostTime: CACurrentMediaTime())
      }
    }
    if throughput { DispatchQueue.main.async(execute: deliver) } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + .microseconds(16_667), execute: deliver)
    }
  }

  @MainActor func deliverTicks(hostTime: Double) {
    guard !closed, !ticks.isEmpty else { return }
    for (token, requested) in ticks {
      var time = hostTime * 1000
      let payload = withUnsafeBytes(of: &time) { Data($0) }
      emitFrame(.tick, a: token, payload: payload)
      let ms = (CACurrentMediaTime() - requested) * 1000
      stats.add("ticks"); stats.add("tickMs", ms); stats.max("tickMaxMs", ms)
    }
    ticks.removeAll()
  }

  @MainActor func resize(width: Int, height: Int, dpr: Double) {
    guard !closed else { return }
    queue.async { [self] in
      if let executor { api.resize(executor, UInt32(width), UInt32(height), dpr) }
    }
    resizeEvent(width: width, height: height, dpr: dpr)
  }
  /// The bridge is the single RESIZE source on the native path (executor RESIZE events are filtered).
  private func resizeEvent(width: Int, height: Int, dpr: Double) {
    let json = "{\"type\":8,\"requestId\":0,\"handle\":0,\"status\":0,\"width\":\(width),\"height\":\(height),\"dpr\":\(dpr)}"
    emitFrame(.event, payload: Data(json.utf8))
  }

  // MARK: executor queue

  private func createExecutor(layer: UnsafeMutableRawPointer?, width: Int, height: Int, dpr: Double) {
    let started = CACurrentMediaTime()
    var options = NtGpuExecutorOptions()
    options.user = Unmanaged.passUnretained(self).toOpaque()
    options.event = { user, json, data, size in
      guard let user, let json else { return }
      Unmanaged<NativeGPUEngineChannel>.fromOpaque(user).takeUnretainedValue().executorEvent(json, data, size)
    }
    options.frame_requested = { user in
      guard let user else { return }
      Unmanaged<NativeGPUEngineChannel>.fromOpaque(user).takeUnretainedValue().emitFrame(.frameRequest)
    }
    options.wake = { user in
      guard let user else { return }
      Unmanaged<NativeGPUEngineChannel>.fromOpaque(user).takeUnretainedValue().wake()
    }
    options.metal_layer = layer
    options.width = UInt32(width); options.height = UInt32(height); options.pixel_ratio = dpr
    var made: OpaquePointer?
    let ok = withUnsafePointer(to: &options) { api.create($0, &made) }
    stats.add("executorCreateMs", (CACurrentMediaTime() - started) * 1000)
    guard ok != 0, let made else {
      queueFailed = true
      let why = api.name == "unlinked"
        ? "native GPU executor pending link: this build has no executor artifact (NT_GPU_EXECUTOR_LIBS)"
        : "native GPU executor creation failed (\(api.name))"
      DispatchQueue.main.async { MainActor.assumeIsolated { self.fail(why) } }
      return
    }
    executor = made
    stats.add("executorsCreated")
  }

  private func wake() {
    let schedule = lock.withLock { () -> Bool in
      if wakeScheduled { return false }
      wakeScheduled = true
      return true
    }
    guard schedule else { return }
    queue.async { [self] in
      lock.withLock { wakeScheduled = false }
      if let executor { api.process(executor); stats.add("processCalls") }
    }
  }

  private func executorEvent(_ json: UnsafePointer<CChar>, _ data: UnsafePointer<UInt8>?, _ size: Int) {
    let text = Data(bytes: json, count: strlen(json))
    guard let object = try? JSONSerialization.jsonObject(with: text) as? [String: Any],
      let type = (object["type"] as? NSNumber)?.intValue
    else { stats.add("malformedExecutorEvents"); return }
    if type == 8 { stats.add("executorResizeFiltered"); return }
    stats.add("events")
    let requestId = (object["requestId"] as? NSNumber)?.uint32Value ?? 0
    if let data, size > 0, type == 3 {
      // Borrowed until return: one copy into downstream frames (bounded chunks).
      let offset = (object["offset"] as? NSNumber)?.uint32Value ?? 0
      var at = 0
      while at < size {
        let n = min(NativeGPUWire.readbackChunkBytes, size - at)
        var prefix = Data(count: 8)
        prefix.withUnsafeMutableBytes { raw in
          raw.storeBytes(of: UInt32(size).littleEndian, toByteOffset: 0, as: UInt32.self)
          raw.storeBytes(of: UInt32(at).littleEndian, toByteOffset: 4, as: UInt32.self)
        }
        prefix.append(data.advanced(by: at), count: n)
        emitFrame(.readback, b: requestId, c: offset, payload: prefix)
        at += n
      }
      stats.add("readbackBytes", Double(size)); stats.add("readbackCopyBytes", Double(size)); stats.add("readbacks")
    }
    emit { out, device in
      text.withUnsafeBytes { raw in NativeGPUWire.append(&out, kind: .event, engine: id, a: device, payload: raw) }
      if type == 5 { self.device += 1 }  // later frames carry the next device epoch
    }
    if type == 5 {
      stats.add("deviceLost")
      DispatchQueue.main.async { MainActor.assumeIsolated { if self.isPresenter { self.bridge.surface?.deviceLost() } } }
    }
  }

  private func queueFail(_ message: String) {
    queueFailed = true
    assembly = nil
    DispatchQueue.main.async { MainActor.assumeIsolated { self.fail(message) } }
  }

  private func queueFrame(_ frame: NativeGPUWire.Frame) {
    let h = frame.header
    switch NativeGPUWire.Kind(rawValue: h.kind) {
    case .open:
      let chunk = frame.payload.count == 4 ? Int(frame.payload.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }) : 0
      guard h.a <= 16 << 20, h.b <= 512 << 20, h.c <= 16 << 20, chunk >= 4096, chunk <= 4 << 20 else {
        queueFail("native GPU open exceeds host limits"); return
      }
      limits = (Int(h.a), Int(h.b), Int(h.c), chunk)
    case .submit:
      guard executor != nil else { queueFail("native GPU submit before an executor exists"); return }
      let chunks = frame.payload.count == 4 ? Int(frame.payload.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }) : 0
      guard assembly == nil, h.sequence == lastSequence &+ 1, Int(h.a) <= limits.commands, Int(h.b) <= limits.uploads,
        Int(h.c) <= limits.readbacks, chunks == 1 + (Int(h.a) + limits.chunk - 1) / limits.chunk + (Int(h.b) + limits.chunk - 1) / limits.chunk
      else { queueFail("native GPU submission header violates the protocol (sequence \(h.sequence))"); return }
      lastSequence = h.sequence
      assembly = Assembly(sequence: h.sequence, chunks: chunks, readbacks: Int(h.c), commands: Section(total: Int(h.a)), uploads: Section(total: Int(h.b)))
      if chunks == 1 { submitAssembled() }
    case .chunk:
      guard var current = assembly, h.sequence == current.sequence, Int(h.a) == current.next,
        frame.payload.count <= limits.chunk, frame.payload.count > 0
      else { queueFail("native GPU chunk out of order"); return }
      let section = h.c & 0xff
      let accepted: Bool
      if section == 0 { accepted = current.commands.take(frame.payload, at: Int(h.b), stats: stats) }
      else if section == 1, current.commands.complete { accepted = current.uploads.take(frame.payload, at: Int(h.b), stats: stats) }
      else { accepted = false }
      guard accepted else { queueFail("native GPU chunk does not continue its section"); return }
      current.next += 1
      assembly = current
      let last = h.flags & NativeGPUWire.flagLast != 0
      if last != (current.next == current.chunks) { queueFail("native GPU last-chunk flag mismatch"); return }
      if last {
        guard current.commands.complete, current.uploads.complete else { queueFail("native GPU submission incomplete"); return }
        submitAssembled()
      }
    default: break
    }
  }

  /// ntgpu_executor_submit retains no pointer after it returns; the ACK follows only after it consumed the batch.
  private func submitAssembled() {
    guard let current = assembly, let executor else { return }
    assembly = nil
    let commands = current.commands.bytes, uploads = current.uploads.bytes
    if current.commands.single != nil { stats.add("zeroCopySections") }
    if current.uploads.single != nil { stats.add("zeroCopySections") }
    let started = CACurrentMediaTime()
    let accepted = commands.withUnsafeBytes { c in
      uploads.withUnsafeBytes { u in
        api.submit(
          executor, c.bindMemory(to: UInt8.self).baseAddress, c.count, u.bindMemory(to: UInt8.self).baseAddress, u.count,
          current.readbacks)
      }
    }
    let ms = (CACurrentMediaTime() - started) * 1000
    stats.add("submissions"); stats.add("submitMs", ms); stats.max("submitMaxMs", ms)
    stats.add("commandBytes", Double(commands.count)); stats.add("uploadBytes", Double(uploads.count))
    if accepted == 0 { stats.add("executorRejected") }
    api.process(executor)
    emitFrame(.ack, sequence: current.sequence)
    stats.add("acks")
  }

  // MARK: teardown

  @MainActor func fail(_ message: String) {
    guard !closed else { return }
    stats.add("engineFailures")
    bridge.onLog("NT_MACOS_NATIVE_GPU_ENGINE_FAILED", "engine=\(id) \(message)")
    lock.withLock { downstreamFailed = false; outbox = Data() }
    emitFrame(.failed, payload: Data(message.utf8))
    lock.withLock { flushScheduled = false }
    flushNow()
    close(message, notify: false)
  }
  /// Delivers what is queued if a poll is held; otherwise it stays queued for the next poll until close.
  @MainActor private func flushNow() {
    guard let stream, stream.live else { return }
    let data = lock.withLock { () -> Data in defer { outbox = Data() }; return outbox }
    guard !data.isEmpty else { return }
    stream.respond(200, type: "application/octet-stream", body: data)
    bridge.forget(stream)
    self.stream = nil
  }

  @MainActor func close(_ reason: String, notify: Bool) {
    guard !closed else { return }
    if notify { emitFrame(.failed, payload: Data("engine generation closed: \(reason)".utf8)); flushNow() }
    closed = true
    ticks.removeAll()
    for (_, (_, task)) in reorder { task.respond(410); bridge.forget(task) }
    reorder.removeAll()
    closeReason = reason
    if let stream { stream.respond(410, body: Data("native GPU engine generation \(id) ended: \(reason)".utf8)); bridge.forget(stream) }
    stream = nil
    lock.withLock { downstreamFailed = true; outbox = Data() }
    let held = lease
    lease = nil
    if held != nil, bridge.active == nil || bridge.active === self { bridge.surface?.cancelFrame() }
    // Executor first (it releases its WGPUSurface), then the CAMetalLayer lease.
    queue.async { [self] in
      queueFailed = true
      assembly = nil
      if let executor { api.destroy(executor); self.executor = nil; stats.add("executorsDestroyed") }
      if let held {
        held.release()
        DispatchQueue.main.async { MainActor.assumeIsolated { self.bridgeRef.leaseReleased() } }
      }
    }
  }

  /// Explicit synchronous capture for probes (never a frame loop). Runs on the executor queue.
  func capture(_ done: @escaping @Sendable (Data?, Int, Int) -> Void) {
    queue.async { [self] in
      guard let executor else { done(nil, 0, 0); return }
      var width: UInt32 = 0, height: UInt32 = 0
      let capacity = 8192 * 8192 * 4
      var data = Data(count: min(capacity, 4096 * 4096 * 4))
      let ok = data.withUnsafeMutableBytes { raw in
        api.capture(executor, raw.bindMemory(to: UInt8.self).baseAddress!, raw.count, &width, &height)
      }
      done(ok != 0 ? data.prefix(Int(width) * Int(height) * 4) : nil, Int(width), Int(height))
    }
  }
}
