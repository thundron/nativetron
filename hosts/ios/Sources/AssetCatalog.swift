import Foundation

/// Offline asset policy for `app://local`. The catalogue is the set of regular files that the
/// build copied from the allowlisted `build/engine-assets` bundle; nothing outside it is served
/// and nothing is fetched from the network.
final class AssetCatalog {
  struct Response {
    let status: Int
    let headers: [String: String]
    /// File to stream for a successful GET; nil for errors and HEAD.
    let file: URL?
  }

  static let scheme = "app"
  static let host = "local"
  static let entry = BundledAssets.entry
  static let origin = "app://local"
  static let maxFileBytes = 64 << 20
  static let maxPathBytes = 1024


  let root: URL
  private let files: [String: (url: URL, size: Int)]
  var paths: [String] { files.keys.sorted() }

  /// Enumerate the bundle once. Symbolic links, hidden-from-policy extensions and oversized
  /// files are excluded, so a later file-system change cannot widen what is served.
  init?(root: URL) {
    let resolved = root.resolvingSymlinksInPath().standardizedFileURL
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDirectory), isDirectory.boolValue,
      let walker = FileManager.default.enumerator(at: resolved, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    else { return nil }
    let prefix = resolved.path.hasSuffix("/") ? resolved.path : resolved.path + "/"
    var files: [String: (URL, Int)] = [:]
    for case let url as URL in walker {
      guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
        values.isSymbolicLink != true, values.isRegularFile == true,
        let size = values.fileSize, size <= Self.maxFileBytes else { continue }
      let path = url.standardizedFileURL.path
      guard path.hasPrefix(prefix) else { continue }
      let relative = String(path.dropFirst(prefix.count))
      guard Self.validRelative(relative), BundledAssets.files[relative] != nil else { continue }
      files[relative] = (url.standardizedFileURL, size)
    }
    guard files[Self.entry] != nil else { return nil }
    self.root = resolved
    self.files = files
  }

  func contains(_ path: String) -> Bool { files[path] != nil }

  func respond(method: String?, url: URL?) -> Response {
    guard let url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme?.lowercased() == Self.scheme, parts.host == Self.host,
      parts.user == nil, parts.password == nil, parts.port == nil else { return error(400) }
    let method = (method ?? "GET").uppercased()
    guard method == "GET" || method == "HEAD" else { return error(405, extra: ["Allow": "GET, HEAD"]) }
    let raw = parts.percentEncodedPath
    // Bundle names never need escapes; refusing them removes every encoded traversal form.
    guard raw.utf8.count <= Self.maxPathBytes, !raw.contains("%"), !raw.contains("\\") else { return error(400) }
    let relative = raw.isEmpty || raw == "/" ? Self.entry : String(raw.dropFirst(raw.hasPrefix("/") ? 1 : 0))
    guard Self.validRelative(relative) else { return error(400) }
    guard let file = files[relative] else { return error(404) }
    var headers = Self.baseHeaders
    let mime = BundledAssets.files[relative]!
    headers["Content-Type"] = mime.hasPrefix("text/") ? mime + "; charset=utf-8" : mime
    headers["Content-Length"] = String(file.size)
    return Response(status: 200, headers: headers, file: method == "GET" ? file.url : nil)
  }

  private func error(_ status: Int, extra: [String: String] = [:]) -> Response {
    var headers = Self.baseHeaders.merging(extra) { $1 }
    headers["Content-Type"] = "text/plain; charset=utf-8"
    headers["Content-Length"] = "0"
    return Response(status: status, headers: headers, file: nil)
  }

  /// Cross-origin isolation keeps SharedArrayBuffer/worker semantics identical to the desktop
  /// host; nosniff and no-store keep WebKit from reinterpreting or caching bundle bytes.
  static let baseHeaders: [String: String] = [
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  ]

  static func validRelative(_ path: String) -> Bool {
    guard !path.isEmpty, !path.hasPrefix("/"), !path.hasSuffix("/") else { return false }
    for segment in path.split(separator: "/", omittingEmptySubsequences: false) {
      if segment.isEmpty || segment == "." || segment == ".." { return false }
      if segment.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f || $0 == ":" }) { return false }
    }
    return true
  }
}
