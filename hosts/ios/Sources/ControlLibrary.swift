import Foundation

/// Receives work queued by the control library. Methods run on the main actor strictly after
/// the native export that produced the frame has returned, so they may call back into
/// `ControlLibrary` freely.
@MainActor protocol ControlLibraryDelegate: AnyObject {
  /// A native→engine COMMAND frame encoded by `nt_control_command`, for delivery to the page.
  func controlLibrary(_ library: ControlLibrary, outbound frame: Data)
  /// An engine→native frame whose routing `nt_control_receive` validated.
  func controlLibrary(_ library: ControlLibrary, inbound frame: Data)
}

/// Owner of the scriptc static control library generated from `ipc/control-profile.json`.
///
/// The archive contains exactly one runtime instance per process, so this object is a
/// process-lifetime singleton and its unretained pointer is the callback userdata. The main
/// thread owns the instance: every export is called from the main actor, and the C callbacks
/// assert main-actor isolation. Callbacks are synchronous and userdata-first; the borrowed
/// bytes are copied before the callback returns and the delivery is queued on the main queue,
/// so platform work never runs inside — or re-enters — the library. There is no outbound FFI.
@MainActor final class ControlLibrary {
  enum Status: String { case accepted, refused, busy, unavailable, oversized, failed, dropped }

  struct Counters {
    var commands = 0, received = 0, refused = 0, captured = 0, dropped = 0, collections = 0
  }

  static let shared = ControlLibrary()
  /// Frames a single export may queue before further callback output is dropped. The control
  /// profile emits exactly one frame per accepted export; the bound only guards drift.
  static let maxPending = 64
  static let maxFrame = 16 + EngineProtocol.maxPayload

  weak var delegate: ControlLibraryDelegate?
  private(set) var counters = Counters()
  private(set) var started = false
  private var inNative = false
  private var pending: [(outbound: Bool, frame: Data)] = []
  private var drainScheduled = false

  private init() {}

  /// Initialise the runtime, install the panic sink and register both profile callbacks.
  /// Idempotent; returns false when registration is refused.
  func start() -> Bool {
    if started { return true }
    guard !inNative else { return false }
    let context = Unmanaged.passUnretained(self).toOpaque()
    inNative = true
    defer { inNative = false }
    nt_control_init()
    nt_control_sink(controlPanicSink, context)
    let send = nt_control_set_callback("controlSend", unsafeBitCast(controlSendCallback, to: (@convention(c) () -> Void).self), context)
    let receive = nt_control_set_callback("controlReceive", unsafeBitCast(controlReceiveCallback, to: (@convention(c) () -> Void).self), context)
    started = send == 0 && receive == 0
    Evidence.emit(started ? "NT_IOS_CONTROL_READY" : "NT_IOS_CONTROL_FAILED", "controlSend=\(send) controlReceive=\(receive)")
    return started
  }

  /// Emit a native→engine COMMAND (requestId 0) through `nt_control_command`.
  func command(topic: UInt32, payload: Data = Data()) -> Status {
    guard payload.count <= EngineProtocol.maxPayload else { counters.refused += 1; return .oversized }
    let status = call { payload.withUnsafeBytes { raw in
      nt_control_command(Double(topic), raw.bindMemory(to: UInt8.self).baseAddress, raw.count)
    } }
    if status == .accepted { counters.commands += 1 }
    return status
  }

  /// Validate an engine→native frame through `nt_control_receive`.
  func receive(frame: Data) -> Status {
    guard frame.count <= Self.maxFrame else { counters.refused += 1; return .oversized }
    let status = call { frame.withUnsafeBytes { raw in
      nt_control_receive(raw.bindMemory(to: UInt8.self).baseAddress, raw.count)
    } }
    if status == .accepted { counters.received += 1 }
    return status
  }

  /// Release runtime garbage (background entry, memory pressure). Never called from a callback.
  @discardableResult func collect() -> Bool {
    guard started, !inNative else { return false }
    inNative = true
    nt_control_collect()
    inNative = false
    counters.collections += 1
    return true
  }

  private func call(_ body: () -> Double) -> Status {
    guard started else { return .unavailable }
    guard !inNative else { return .busy }
    inNative = true
    let dropped = counters.dropped
    let result = body()
    inNative = false
    scheduleDrain()
    switch result {
    case 0: return counters.dropped == dropped ? .accepted : .dropped
    case 1: counters.refused += 1; return .refused
    default: counters.refused += 1; return .failed
    }
  }

  /// Called synchronously from inside the library: copy, enqueue, return. No platform work.
  fileprivate func capture(outbound: Bool, bytes: UnsafePointer<UInt8>?, length: Int) {
    guard inNative, let bytes, length >= 16, length <= Self.maxFrame, pending.count < Self.maxPending else {
      counters.dropped += 1
      return
    }
    pending.append((outbound, Data(bytes: bytes, count: length)))
    counters.captured += 1
  }

  private func scheduleDrain() {
    guard !pending.isEmpty, !drainScheduled else { return }
    drainScheduled = true
    DispatchQueue.main.async { [self] in
      drainScheduled = false
      let items = pending
      pending.removeAll()
      for item in items {
        guard let delegate else { counters.dropped += 1; continue }
        if item.outbound { delegate.controlLibrary(self, outbound: item.frame) }
        else { delegate.controlLibrary(self, inbound: item.frame) }
      }
    }
  }

  fileprivate static func from(_ context: UnsafeMutableRawPointer?) -> ControlLibrary? {
    context.map { Unmanaged<ControlLibrary>.fromOpaque($0).takeUnretainedValue() }
  }
}

private let controlSendCallback: nt_control_bytes_callback = { context, bytes, length in
  MainActor.assumeIsolated { ControlLibrary.from(context)?.capture(outbound: true, bytes: bytes, length: length) }
}

private let controlReceiveCallback: nt_control_bytes_callback = { context, bytes, length in
  MainActor.assumeIsolated { ControlLibrary.from(context)?.capture(outbound: false, bytes: bytes, length: length) }
}

/// The runtime aborts after the sink returns; the instance is unusable after a trap. Only copy
/// and log the structured diagnostic here.
private let controlPanicSink: nt_control_panic_callback = { _, bytes, length, address in
  let text = bytes.map { String(decoding: UnsafeBufferPointer(start: $0, count: min(length, 2048)), as: UTF8.self) } ?? ""
  Evidence.emit("NT_IOS_CONTROL_PANIC", "address=\(address) " + text.replacingOccurrences(of: "\u{1f}", with: " | "))
}
