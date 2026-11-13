import Foundation
@preconcurrency import WebKit

/// One WKURLSchemeHandler per scheme: `/__ntgpu/` goes to the native GPU bridge (when enabled), `app://dev/`
/// to an owner-local read-only development root (when `--url file:///tmp/...` was given), everything else
/// to the bundled AssetSchemeHandler on `app://local`.
@MainActor final class MacSchemeRouter: NSObject, WKURLSchemeHandler {
  let assets: AssetSchemeHandler
  var gpu: NativeGPUBridge?
  var dev: DevContentRoot?
  private var devTasks = Set<ObjectIdentifier>()
  init(assets: AssetSchemeHandler) { self.assets = assets }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    if let gpu, gpu.handles(task.request.url) { gpu.start(task); return }
    if task.request.url?.host == DevContentRoot.host {
      guard let dev else { fail(task, 404); return }
      let response = dev.respond(method: task.request.httpMethod, url: task.request.url)
      guard let url = task.request.url,
        let head = HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1", headerFields: response.headers)
      else { fail(task, 400); return }
      task.didReceive(head)
      if let data = response.data { task.didReceive(data) }
      task.didFinish()
      return
    }
    assets.webView(webView, start: task)
  }
  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    if let gpu, gpu.handles(task.request.url) { gpu.stop(task); return }
    if task.request.url?.host == DevContentRoot.host { return }
    assets.webView(webView, stop: task)
  }
  private func fail(_ task: WKURLSchemeTask, _ status: Int) {
    guard let url = task.request.url ?? URL(string: "app://local/"),
      let head = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: AssetCatalog.baseHeaders)
    else { return }
    task.didReceive(head)
    task.didFinish()
  }
}

/// Owner-local, read-only development content for `--url file:///tmp/<dir>/<page>.html` (for example a locally
/// built house-planner UI). Served as `app://dev/<relative>` — a different origin from `app://local`, so the
/// host-services broker (bound to app://local) is never exposed to it. Only the native GPU endpoint, which is
/// bound to whatever origin the main frame has, is reachable (and only with --native-gpu). Remote URLs are refused.
struct DevContentRoot {
  static let host = "dev"
  static let maxFileBytes = 256 << 20
  let root: URL
  let entry: String

  /// nil (with a reason) unless the file is a regular .html under /private/tmp, the directory is owned by this
  /// user and not group/world-writable, and nothing escapes it through symlinks.
  static func validate(_ text: String) -> Result<DevContentRoot, DevContentError> {
    guard let url = URL(string: text), url.isFileURL else { return .failure(.init("--url must be a file:// URL under /tmp")) }
    let real = url.resolvingSymlinksInPath()
    let path = real.path
    guard path.hasPrefix("/private/tmp/") || path.hasPrefix("/tmp/") else { return .failure(.init("--url must point under /tmp")) }
    guard path.hasSuffix(".html") else { return .failure(.init("--url must name an .html file")) }
    let directory = real.deletingLastPathComponent()
    var info = stat()
    guard lstat(directory.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else { return .failure(.init("--url directory missing")) }
    guard info.st_uid == getuid() else { return .failure(.init("--url directory must be owned by the current user")) }
    guard info.st_mode & 0o022 == 0 else { return .failure(.init("--url directory must not be group/world-writable")) }
    var file = stat()
    guard lstat(path, &file) == 0, (file.st_mode & S_IFMT) == S_IFREG else { return .failure(.init("--url file missing")) }
    return .success(DevContentRoot(root: directory, entry: real.lastPathComponent))
  }

  struct Response { var status: Int; var headers: [String: String]; var data: Data? }

  func respond(method: String?, url: URL?) -> Response {
    var headers = AssetCatalog.baseHeaders
    headers["Access-Control-Allow-Origin"] = nil
    headers["Content-Type"] = "text/plain; charset=utf-8"
    guard let url, url.scheme == AssetCatalog.scheme, url.host == Self.host else { return Response(status: 400, headers: headers) }
    let verb = (method ?? "GET").uppercased()
    guard verb == "GET" || verb == "HEAD" else { return Response(status: 405, headers: headers) }
    let raw = url.path
    guard !raw.contains("\\"), raw.utf8.count <= AssetCatalog.maxPathBytes else { return Response(status: 400, headers: headers) }
    let relative = raw.isEmpty || raw == "/" ? entry : String(raw.dropFirst())
    guard AssetCatalog.validRelative(relative) else { return Response(status: 400, headers: headers) }
    let file = root.appendingPathComponent(relative).resolvingSymlinksInPath()
    guard file.path.hasPrefix(root.resolvingSymlinksInPath().path + "/") else { return Response(status: 403, headers: headers) }
    var info = stat()
    guard lstat(file.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, Int(info.st_size) <= Self.maxFileBytes,
      let data = verb == "GET" ? (try? Data(contentsOf: file, options: .mappedIfSafe)) : Data()
    else { return Response(status: 404, headers: headers) }
    headers["Content-Type"] = Self.mime(file.pathExtension)
    return Response(status: 200, headers: headers, data: verb == "GET" ? data : nil)
  }

  static func mime(_ ext: String) -> String {
    switch ext.lowercased() {
    case "html": return "text/html; charset=utf-8"
    case "js", "mjs": return "text/javascript; charset=utf-8"
    case "css": return "text/css; charset=utf-8"
    case "json", "map": return "application/json"
    case "wasm": return "application/wasm"
    case "png": return "image/png"
    case "jpg", "jpeg": return "image/jpeg"
    case "svg": return "image/svg+xml"
    case "woff2": return "font/woff2"
    case "glb", "bin", "ktx2": return "application/octet-stream"
    default: return "application/octet-stream"
    }
  }
}

struct DevContentError: Error, CustomStringConvertible {
  let description: String
  init(_ text: String) { description = text }
}
