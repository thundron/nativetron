import Foundation

// Deterministic checks of NativeGPUWire (the Swift half of engine/native-gpu-wire.js). No WebKit, no GPU.
var failures = 0
func check(_ ok: Bool, _ name: String) { if !ok { failures += 1; print("FAIL", name) } }

func upstream(_ kind: NativeGPUWire.Kind, engine: UInt32 = 1, sequence: UInt32 = 0, a: UInt32 = 0, payload: Data = Data()) -> Data {
  // Upstream frames share the downstream layout; build them with the same encoder.
  NativeGPUWire.frame(kind, engine: engine, sequence: sequence, a: a, payload: payload)
}

do {
  var body = upstream(.submit, sequence: 3, a: 64, payload: Data([1, 0, 0, 0]))
  let chunk = Data((0..<4099).map { UInt8($0 & 255) })
  body.append(upstream(.chunk, sequence: 3, a: 1, payload: chunk))
  body.append(upstream(.tickRequest, a: 9))
  let frames = try NativeGPUWire.parseUpstream(body)
  check(frames.map(\.header.kind) == [2, 3, 5], "kinds in order")
  check(frames[1].payload == chunk, "chunk payload exact")
  check(frames[0].header.sequence == 3 && frames[0].header.a == 64, "header fields")
  // Payloads are slices of the body (shared storage), not copies.
  body.withUnsafeBytes { whole in
    frames[1].payload.withUnsafeBytes { part in
      let start = whole.baseAddress!, end = start + whole.count
      check(part.baseAddress! >= start && part.baseAddress! + part.count <= end, "payload is a slice of the body")
    }
  }
  // A body sliced out of a larger Data (non-zero startIndex) parses the same.
  let shifted = (Data([9, 9, 9, 9]) + body).dropFirst(4)
  check(try NativeGPUWire.parseUpstream(shifted).count == 3, "non-zero startIndex body")
} catch { check(false, "valid body parses: \(error)") }

func rejects(_ body: Data, _ name: String) {
  do { _ = try NativeGPUWire.parseUpstream(body); check(false, name) } catch {}
}
var bad = upstream(.open); bad[0] ^= 1
rejects(bad, "bad magic")
rejects(upstream(.ack), "downstream kind upstream")
rejects(upstream(.frameDone, a: 1), "frame completion is downstream only")
do {
  // FRAME_END rides with the frame's last chunk: a = frame, sequence = its last submission.
  let frames = try NativeGPUWire.parseUpstream(upstream(.frameEnd, sequence: 12, a: 5))
  check(frames.count == 1 && frames[0].header.kind == 8 && frames[0].header.a == 5 && frames[0].header.sequence == 12, "frame end parses")
} catch { check(false, "frame end parses: \(error)") }
let done = NativeGPUWire.frame(.frameDone, engine: 3, a: 5, b: 1)
check(done.count == 32 && done[4] == 22 && done[16] == 5 && done[20] == 1, "frame done encodes frame and status")
rejects(upstream(.event, payload: Data(count: 8)), "downstream event upstream")
rejects(upstream(.frameMode, payload: Data(count: NativeGPUWire.maxControlPayload + 4)), "oversized control payload")
rejects(upstream(.chunk, payload: Data(count: 100)).prefix(80), "truncated payload")
rejects(upstream(.open).prefix(20), "truncated header")
var unknown = upstream(.open); unknown[4] = 99
rejects(unknown, "unknown kind")

// Downstream encoding pads to 4 bytes and stores the payload length.
let event = NativeGPUWire.frame(.event, engine: 7, a: 2, payload: Data("{}x".utf8))
check(event.count == 36, "padding")
check(event[28] == 3 && event[8] == 7 && event[16] == 2, "downstream header fields")

if failures == 0 { print("NT_NATIVE_GPU_WIRE_SWIFT_PASS") } else { exit(1) }
