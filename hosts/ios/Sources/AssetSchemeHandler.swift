import Foundation
@preconcurrency import WebKit

/// Serves the `AssetCatalog` on `app://local`. File reads run off the main thread; responses
/// are delivered on the main actor only while WebKit has not stopped the task, so a cancelled
/// load (navigation, reload, disposal) never receives bytes after `stop`.
@MainActor final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
  private let catalog: AssetCatalog?
  private var active = Set<ObjectIdentifier>()
  private let io = DispatchQueue(label: "dev.nativetron.assets", qos: .userInitiated)
  private(set) var served = 0, refused = 0

  init(catalog: AssetCatalog?) { self.catalog = catalog }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    let id = ObjectIdentifier(task)
    let request = task.request
    guard let catalog else { finish(task, status: 500, headers: ["Content-Type": "text/plain"], data: nil); return }
    let response = catalog.respond(method: request.httpMethod, url: request.url)
    guard let file = response.file else {
      if response.status != 200 {
        refused += 1
        Evidence.emit("NT_IOS_ASSET_REFUSED", "\(response.status) \(request.url?.absoluteString ?? "<nil>")")
      }
      finish(task, status: response.status, headers: response.headers, data: nil)
      return
    }
    active.insert(id)
    let box = TaskBox(task: task)
    io.async { [weak self] in
      let data = try? Data(contentsOf: file, options: .mappedIfSafe)
      DispatchQueue.main.async {
        guard let self, self.active.remove(id) != nil else { return }
        guard let data else {
          self.refused += 1
          Evidence.emit("NT_IOS_ASSET_READ_FAILED", file.lastPathComponent)
          self.finish(box.task, status: 500, headers: ["Content-Type": "text/plain", "Content-Length": "0"], data: nil)
          return
        }
        self.served += 1
        self.finish(box.task, status: response.status, headers: response.headers, data: data)
      }
    }
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    active.remove(ObjectIdentifier(task))
  }

  /// Drop all in-flight reads; called when the owning web view is disposed.
  func cancelAll() { active.removeAll() }

  private func finish(_ task: WKURLSchemeTask, status: Int, headers: [String: String], data: Data?) {
    guard let url = task.request.url ?? URL(string: AssetCatalog.origin + "/"),
      let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
      task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL))
      return
    }
    task.didReceive(response)
    if let data, !data.isEmpty { task.didReceive(data) }
    task.didFinish()
  }
}

/// WebKit hands scheme tasks to the main actor and they are only touched there; the box only
/// carries the reference across the file-read hop.
private struct TaskBox: @unchecked Sendable { let task: WKURLSchemeTask }
