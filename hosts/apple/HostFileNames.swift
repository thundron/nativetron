import Foundation

// Display names never become paths. A conservative suffix is retained on the
// private UUID URL because Photos/AVFoundation also use URL type information.
enum HostFileNames {
  static func suffix(_ name: String) -> String? {
    let value = URL(fileURLWithPath: name).pathExtension.lowercased()
    return value.range(of: "^[a-z0-9]{1,16}$", options: .regularExpression) != nil ? value : nil
  }
  static func stagingURL(in directory: URL, name: String) -> URL {
    let url = directory.appendingPathComponent(UUID().uuidString)
    return suffix(name).map { url.appendingPathExtension($0) } ?? url
  }
}
