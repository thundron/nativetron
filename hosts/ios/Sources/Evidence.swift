import Foundation
import os

/// Structured host evidence. Every line starts with an `NT_IOS_` marker and goes to both the
/// unified log (subsystem `dev.nativetron.gpu`) and stdout, so `simctl log stream`,
/// `simctl launch --console-pty` and `devicectl ... --console` all observe the same lines.
enum Evidence {
  static let subsystem = "dev.nativetron.gpu"
  static let maxLine = 4096
  private static let logger = Logger(subsystem: subsystem, category: "host")

  static func emit(_ marker: String, _ detail: String = "") {
    let line = detail.isEmpty ? marker : marker + " " + sanitize(detail)
    logger.notice("\(line, privacy: .public)")
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
  }

  /// Collapse control characters (including newlines) and bound the length, so a hostile or
  /// noisy page cannot forge additional evidence lines or flood the log.
  static func sanitize(_ text: String) -> String {
    var out = String.UnicodeScalarView()
    var count = 0
    for scalar in text.unicodeScalars {
      if count == maxLine { out.append(contentsOf: "…".unicodeScalars); break }
      out.append(scalar.value < 0x20 || scalar.value == 0x7f ? " " : scalar)
      count += 1
    }
    return String(out)
  }
}

/// Fixed one-second admission window used for every page/native channel.
struct RateWindow {
  let limit: Int
  private var start = Date.distantPast
  private var count = 0
  private(set) var rejected = 0
  init(limit: Int) { self.limit = limit }
  mutating func admit(now: Date = Date()) -> Bool {
    if now.timeIntervalSince(start) >= 1 || now < start { start = now; count = 0 }
    guard count < limit else { rejected += 1; return false }
    count += 1
    return true
  }
}
