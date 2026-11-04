// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit
import Foundation
import CoreFoundation

enum EngineProtocol {
  static let maxPayload = 65536
  static let maxRate = 60
  static let maxEnvelope = 87468
  static func valid(_ data: Data) -> Bool {
    let b = [UInt8](data)
    guard b.count >= 16, b.count <= 65552, b[0] == 1,
      (1...5).contains(Int(b[1])),
      b[2] <= 2, b[3] <= 2, b[2] != b[3] else { return false }
    let length = (0..<4).reduce(UInt32(0)) { $0 | UInt32(b[12 + $1]) << ($1 * 8) }
    return Int(length) == b.count - 16
  }
  static func decodeEnvelope(_ text: String) -> Data? {
    guard text.utf8.count <= maxEnvelope, let json = text.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any], object.count == 2,
      let marker = object["ntEngine"] as? NSNumber, CFGetTypeID(marker) != CFBooleanGetTypeID(), marker.doubleValue == 1,
      let encoded = object["frame"] as? String, let bytes = Data(base64Encoded: encoded),
      bytes.base64EncodedString() == encoded, valid(bytes) else { return nil }
    return bytes
  }
  static func envelope(_ bytes: Data) -> String? {
    guard valid(bytes), let json = try? JSONSerialization.data(withJSONObject: ["ntEngine": 1, "frame": bytes.base64EncodedString()]) else { return nil }
    return String(data: json, encoding: .utf8)
  }
  static func command(topic: UInt32, payload: Data = Data()) -> Data? {
    guard payload.count <= maxPayload else { return nil }
    var bytes = [UInt8](repeating: 0, count: 16)
    bytes[0] = 1; bytes[1] = 1
    bytes[2] = 0; bytes[3] = 2
    for shift in 0..<4 {
      bytes[8 + shift] = UInt8(truncatingIfNeeded: topic >> (shift * 8))
      bytes[12 + shift] = UInt8(truncatingIfNeeded: payload.count >> (shift * 8))
    }
    return Data(bytes) + payload
  }
  static func payload(_ bytes: Data) -> Data { bytes.dropFirst(16) }
  static func fromEngineToNative(_ bytes: Data) -> Bool { valid(bytes) && bytes[2] == 2 && bytes[3] == 0 }
}
