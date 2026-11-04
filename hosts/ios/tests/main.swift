// Host-side conformance harness for the iOS host's platform-independent sources
// (ControlLibrary, AssetCatalog, AssetProbe, Evidence, generated EngineProtocol), linked with
// the REAL scriptc control archive built for macOS from ipc/control-profile.json.
// Built and run by hosts/ios/test.sh.
import Foundation

nonisolated(unsafe) var failures = 0
nonisolated(unsafe) var passes = 0
func expect(_ condition: @autoclosure () -> Bool, _ name: String, file: StaticString = #fileID, line: UInt = #line) {
  if condition() { passes += 1 } else { failures += 1; print("FAIL \(name) (\(file):\(line))") }
}
func spin(_ seconds: TimeInterval = 0.05) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

@MainActor final class Recorder: ControlLibraryDelegate {
  var outbound: [Data] = [], inbound: [Data] = []
  var onOutbound: ((Data) -> Void)?
  func controlLibrary(_ library: ControlLibrary, outbound frame: Data) { outbound.append(frame); onOutbound?(frame) }
  func controlLibrary(_ library: ControlLibrary, inbound frame: Data) { inbound.append(frame) }
}

func frame(kind: UInt8, source: UInt8, target: UInt8, requestId: UInt32 = 0, topic: UInt32 = 0, payload: [UInt8] = []) -> Data {
  var bytes: [UInt8] = [1, kind, source, target]
  for value in [requestId, topic, UInt32(payload.count)] { for shift in 0..<4 { bytes.append(UInt8(truncatingIfNeeded: value >> (shift * 8))) } }
  return Data(bytes + payload)
}

@MainActor func controlTests() {
  let library = ControlLibrary.shared
  expect(library.command(topic: 1) == .unavailable, "command before start is refused without native call")
  expect(library.start(), "start registers both callbacks")
  expect(library.start(), "start is idempotent")
  let recorder = Recorder()
  library.delegate = recorder

  // native → engine COMMAND: exact generated wire bytes, delivered after the export returns.
  expect(library.command(topic: 1) == .accepted, "command accepted")
  expect(recorder.outbound.isEmpty, "callback work is queued, not delivered inside the export")
  spin()
  expect(recorder.outbound == [EngineProtocol.command(topic: 1)!], "command frame matches generated codec")
  expect(recorder.outbound.first.map { [UInt8]($0.prefix(8)) } == [1, 1, 0, 2, 0, 0, 0, 0], "COMMAND native→engine requestId 0")

  recorder.outbound.removeAll()
  let payload = Data([7, 8, 9])
  expect(library.command(topic: 0xFFFF_FFFF, payload: payload) == .accepted, "max u32 topic accepted")
  spin()
  expect(recorder.outbound == [EngineProtocol.command(topic: 0xFFFF_FFFF, payload: payload)!], "payload and topic preserved")

  recorder.outbound.removeAll()
  expect(library.command(topic: 2, payload: Data(count: EngineProtocol.maxPayload)) == .accepted, "64 KiB payload accepted")
  spin()
  expect(recorder.outbound.first?.count == 16 + EngineProtocol.maxPayload, "64 KiB frame delivered")
  expect(library.command(topic: 2, payload: Data(count: EngineProtocol.maxPayload + 1)) == .oversized, "oversized payload refused before FFI")

  // Delegate work may call the library again: it runs strictly outside the callback.
  recorder.outbound.removeAll()
  var nested: ControlLibrary.Status?
  recorder.onOutbound = { _ in if nested == nil { nested = library.command(topic: 3) } }
  _ = library.command(topic: 4)
  spin(); spin()
  expect(nested == .accepted, "delegate may re-enter the wrapper after the export returned")
  expect(recorder.outbound.count == 2, "nested command delivered")
  recorder.onOutbound = nil

  // engine → native routing validated by nt_control_receive.
  let report = frame(kind: 5, source: 2, target: 0, payload: Array("GPU_READBACK_OK 4096".utf8))
  expect(library.receive(frame: report) == .accepted, "engine→native report accepted")
  expect(recorder.inbound.isEmpty, "receive delivery is queued")
  spin()
  expect(recorder.inbound == [report], "receive callback delivers the identical frame")
  recorder.inbound.removeAll()
  for (name, bad) in [
    ("native→engine", frame(kind: 1, source: 0, target: 2)),
    ("ui→native", frame(kind: 5, source: 1, target: 0)),
    ("engine→ui", frame(kind: 5, source: 2, target: 1)),
    ("short", Data([1, 5, 2, 0])),
    ("bad version", { var f = frame(kind: 5, source: 2, target: 0); f[0] = 2; return f }()),
    ("bad kind", frame(kind: 9, source: 2, target: 0)),
    ("length mismatch", frame(kind: 5, source: 2, target: 0, payload: [1]).dropLast()),
    ("empty", Data()),
  ] {
    expect(library.receive(frame: Data(bad)) == .refused, "refuses \(name)")
  }
  spin()
  expect(recorder.inbound.isEmpty, "refused frames never reach the delegate")
  expect(library.receive(frame: Data(count: ControlLibrary.maxFrame + 1)) == .oversized, "oversized inbound refused before FFI")

  // Collection and weak delegate lifetime.
  expect(library.collect(), "collect outside callbacks")
  var weakRecorder: Recorder? = Recorder()
  library.delegate = weakRecorder
  weak let probe = weakRecorder
  weakRecorder = nil
  expect(probe == nil && library.delegate == nil, "library holds its delegate weakly")
  let dropped = library.counters.dropped
  _ = library.command(topic: 1)
  spin()
  expect(library.counters.dropped == dropped + 1, "frames without a delegate are dropped, not retained")
  library.delegate = recorder

  // Repeated traffic keeps the runtime bounded (arena reset per export, periodic collection).
  recorder.outbound.removeAll()
  for index in 0..<2000 { _ = library.command(topic: UInt32(index % 7), payload: Data(count: index % 512)); if index % 50 == 49 { spin(0.001) } }
  spin()
  expect(recorder.outbound.count == 2000, "2000 commands delivered in order")
  expect(recorder.outbound.enumerated().allSatisfy { EngineProtocol.valid($0.element) && $0.element.count == 16 + $0.offset % 512 }, "every frame valid and ordered")
  expect(library.collect(), "collect after load")

  // The undrained queue is bounded: output beyond maxPending is dropped and counted.
  recorder.outbound.removeAll()
  let before = library.counters.dropped
  let statuses = (0..<(ControlLibrary.maxPending + 5)).map { _ in library.command(topic: 9) }
  spin()
  expect(statuses.prefix(ControlLibrary.maxPending).allSatisfy { $0 == .accepted } && statuses.suffix(5).allSatisfy { $0 == .dropped }, "overflowing commands report dropped")
  expect(recorder.outbound.count == ControlLibrary.maxPending, "undrained callback queue bounded")
  expect(library.counters.dropped == before + 5, "overflow counted as dropped")
}

func assetTests() throws {
  let base = FileManager.default.temporaryDirectory.appendingPathComponent("nt-ios-assets-\(UUID().uuidString)")
  let root = base.appendingPathComponent("engine-assets")
  defer { try? FileManager.default.removeItem(at: base) }
  func write(_ path: String, _ text: String, in dir: URL? = nil) throws {
    let url = (dir ?? root).appendingPathComponent(path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)
  }
  try write("engine/page.html", "<!doctype html>")
  try write("engine/host.js", "export {}")
  try write("engine/.scriptc/ui.wasm", "\0asm")
  try write("engine/secret.plist", "<plist/>")
  try write("engine/unknown.js", "export {}")
  try write("outside.js", "outside", in: base)
  try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("engine/link.js"), withDestinationURL: base.appendingPathComponent("outside.js"))
  guard let catalog = AssetCatalog(root: root) else { expect(false, "catalog builds"); return }
  expect(catalog.paths == ["engine/.scriptc/ui.wasm", "engine/host.js", "engine/page.html"], "catalog lists only allowlisted regular files: \(catalog.paths)")
  func get(_ text: String, _ method: String? = "GET") -> AssetCatalog.Response { catalog.respond(method: method, url: URL(string: text)) }
  let page = get("app://local/")
  expect(page.status == 200 && page.headers["Content-Type"] == "text/html; charset=utf-8" && page.file != nil, "root serves entry")
  expect(page.headers["Cross-Origin-Embedder-Policy"] == "require-corp" && page.headers["Cross-Origin-Opener-Policy"] == "same-origin", "isolation headers")
  expect(page.headers["X-Content-Type-Options"] == "nosniff" && page.headers["Cache-Control"] == "no-store", "nosniff and no-store")
  expect(page.headers["Content-Length"] == "15", "content length")
  expect(get("app://local/engine/page.html?main").status == 200, "query ignored for lookup")
  expect(get("app://local/engine/.scriptc/ui.wasm").headers["Content-Type"] == "application/wasm", "wasm MIME")
  expect(get("app://local/engine/host.js").headers["Content-Type"] == "text/javascript; charset=utf-8", "module MIME")
  let head = get("app://local/engine/host.js", "HEAD")
  expect(head.status == 200 && head.file == nil, "HEAD has headers and no body")
  expect(get("app://local/engine/host.js", "POST").status == 405, "POST refused")
  expect(get("app://local/engine/absent.js").status == 404, "missing file 404")
  expect(get("app://local/engine/unknown.js").status == 404, "unmanifested JavaScript not served")
  expect(get("app://local/engine/link.js").status == 404, "symlink not served")
  expect(get("app://local/engine/secret.plist").status == 404, "non-allowlisted type not served")
  expect(get("app://local/outside.js").status == 404, "file outside root not served")
  for (name, url) in [
    ("dot-dot", "app://local/engine/../outside.js"), ("dot", "app://local/engine/./host.js"),
    ("encoded dot-dot", "app://local/engine/%2e%2e/outside.js"), ("encoded slash", "app://local/engine%2fhost.js"),
    ("double slash", "app://local//engine/host.js"), ("trailing slash", "app://local/engine/"),
    ("other host", "app://evil/engine/host.js"), ("other scheme", "https://local/engine/host.js"),
    ("port", "app://local:8080/engine/host.js"), ("user", "app://x@local/engine/host.js"),
    ("nil url", "not a url with spaces"),
  ] {
    let status = get(url).status
    expect(status == 400 || (name == "nil url" && status == 400), "refuses \(name) (\(status))")
  }
  expect(get("app://local/" + String(repeating: "a/", count: 600) + "x.js").status == 400, "overlong path refused")
  expect(AssetCatalog(root: base.appendingPathComponent("absent")) == nil, "missing bundle refused")
}

func probeTests() {
  let good = """
    {"page":{"status":200,"type":"text/html; charset=utf-8"},"wasm":{"status":200,"type":"application/wasm"},
     "module":{"status":200,"type":"text/javascript; charset=utf-8","nosniff":"nosniff"},"head":{"status":200},
     "post":{"status":405},"missing":{"status":404},"traversal":{"status":404},"encoded":{"status":400},
     "bundle":{"status":404},"external":{"error":"TypeError"}}
    """
  expect(AssetProbe.judge(good).isEmpty, "probe judge accepts held policy: \(AssetProbe.judge(good))")
  let bad = good.replacingOccurrences(of: "application/wasm", with: "application/octet-stream")
    .replacingOccurrences(of: "\"external\":{\"error\":\"TypeError\"}", with: "\"external\":{\"status\":200}")
  expect(AssetProbe.judge(bad) == ["wasm-mime", "external-reachable"], "probe judge reports violations: \(AssetProbe.judge(bad))")
  expect(AssetProbe.judge(nil) == ["unparsed"], "probe judge refuses missing result")
}

func evidenceTests() {
  expect(Evidence.sanitize("a\nNT_IOS_ACCEPT_DONE status=pass") == "a NT_IOS_ACCEPT_DONE status=pass", "newlines cannot forge evidence lines")
  expect(Evidence.sanitize(String(repeating: "x", count: 5000)).count == Evidence.maxLine + 1, "evidence lines bounded")
  var window = RateWindow(limit: 2)
  let now = Date()
  expect(window.admit(now: now) && window.admit(now: now) && !window.admit(now: now), "rate window bounds per second")
  expect(window.admit(now: now.addingTimeInterval(1)), "rate window resets")
}

MainActor.assumeIsolated { controlTests() }
do { try assetTests() } catch { failures += 1; print("FAIL asset fixture: \(error)") }
probeTests()
evidenceTests()
print("ios host harness: \(passes) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
