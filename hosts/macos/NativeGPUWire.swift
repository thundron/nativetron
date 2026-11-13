import Foundation

/// Binary frame layout shared with engine/native-gpu-wire.js (32-byte little-endian header,
/// payload, padding to 4 bytes). Pure value code: no WebKit, no executor, no threads.
enum NativeGPUWire {
  static let magic: UInt32 = 0x3157_474E  // "NGW1"
  static let headerBytes = 32
  static let maxBodyBytes = 4 * 1_048_576 + 65_536  // one chunk + reserved control frames
  static let maxControlPayload = 4096
  static let readbackChunkBytes = 4 * 1_048_576
  enum Kind: UInt16 {
    case open = 1, submit = 2, chunk = 3, frameMode = 4, tickRequest = 5, tickCancel = 6, close = 7
    /// a = frame, sequence = its last submission: fence that frame's GPU work (ntgpu_executor_fence).
    case frameEnd = 8
    case ack = 16, event = 17, readback = 18, frameRequest = 19, failed = 20, tick = 21
    /// a = frame, b = status (0 done, 1 lost, 2 cancelled): the GPU finished every flush of the frame.
    case frameDone = 22
  }
  static let flagLast: UInt16 = 1
  static let flagThroughput: UInt16 = 1

  struct Header: Equatable {
    var kind: UInt16, flags: UInt16 = 0, engine: UInt32, sequence: UInt32 = 0
    var a: UInt32 = 0, b: UInt32 = 0, c: UInt32 = 0, payloadBytes: UInt32 = 0
  }
  struct Frame {
    var header: Header
    /// Slice of the received body (shares its storage; no copy).
    var payload: Data
  }
  enum ParseError: Error, Equatable {
    case badMagic(Int), truncated(Int), oversized(Int), unknownKind(UInt16), notUpstream(UInt16)
  }

  static func align4(_ n: Int) -> Int { (n + 3) & ~3 }

  /// Splits one upstream POST body into frames. Every frame must be a known upstream kind; control
  /// payloads are bounded; chunk payloads are bounded by the body itself.
  static func parseUpstream(_ body: Data) throws -> [Frame] {
    var frames: [Frame] = []
    let count = body.count
    let base = body.startIndex
    var at = 0
    while at < count {
      guard count - at >= headerBytes else { throw ParseError.truncated(at) }
      let header = body.withUnsafeBytes { raw -> Header? in
        let p = raw.baseAddress!.advanced(by: at)
        func u32(_ o: Int) -> UInt32 { UInt32(littleEndian: p.loadUnaligned(fromByteOffset: o, as: UInt32.self)) }
        func u16(_ o: Int) -> UInt16 { UInt16(littleEndian: p.loadUnaligned(fromByteOffset: o, as: UInt16.self)) }
        guard u32(0) == magic else { return nil }
        return Header(
          kind: u16(4), flags: u16(6), engine: u32(8), sequence: u32(12), a: u32(16), b: u32(20),
          c: u32(24), payloadBytes: u32(28))
      }
      guard let header else { throw ParseError.badMagic(at) }
      guard let kind = Kind(rawValue: header.kind) else { throw ParseError.unknownKind(header.kind) }
      guard kind.rawValue < Kind.ack.rawValue else { throw ParseError.notUpstream(header.kind) }
      let size = Int(header.payloadBytes)
      if kind != .chunk && size > maxControlPayload { throw ParseError.oversized(at) }
      guard size <= count - at - headerBytes else { throw ParseError.truncated(at) }
      let start = base + at + headerBytes
      frames.append(Frame(header: header, payload: body[start..<(start + size)]))
      at = min(count, at + align4(headerBytes + size))
    }
    return frames
  }

  /// Encodes one downstream frame (header + payload + padding) into `out`.
  static func append(
    _ out: inout Data, kind: Kind, flags: UInt16 = 0, engine: UInt32, sequence: UInt32 = 0,
    a: UInt32 = 0, b: UInt32 = 0, c: UInt32 = 0, payload: UnsafeRawBufferPointer? = nil
  ) {
    let size = payload?.count ?? 0
    var header = [UInt8](repeating: 0, count: headerBytes)
    header.withUnsafeMutableBytes { raw in
      func put32(_ o: Int, _ v: UInt32) { raw.storeBytes(of: v.littleEndian, toByteOffset: o, as: UInt32.self) }
      put32(0, magic)
      raw.storeBytes(of: kind.rawValue.littleEndian, toByteOffset: 4, as: UInt16.self)
      raw.storeBytes(of: flags.littleEndian, toByteOffset: 6, as: UInt16.self)
      put32(8, engine); put32(12, sequence); put32(16, a); put32(20, b); put32(24, c)
      put32(28, UInt32(size))
    }
    out.append(contentsOf: header)
    if let payload, size > 0 { out.append(payload.bindMemory(to: UInt8.self)) }
    let pad = align4(headerBytes + size) - headerBytes - size
    if pad > 0 { out.append(contentsOf: [UInt8](repeating: 0, count: pad)) }
  }

  static func frame(
    _ kind: Kind, engine: UInt32, sequence: UInt32 = 0, a: UInt32 = 0, b: UInt32 = 0, c: UInt32 = 0,
    payload: Data = Data()
  ) -> Data {
    var out = Data(capacity: align4(headerBytes + payload.count))
    payload.withUnsafeBytes { raw in
      append(&out, kind: kind, engine: engine, sequence: sequence, a: a, b: b, c: c, payload: raw)
    }
    return out
  }
}
