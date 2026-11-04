import Foundation

/// In-WebKit probe of the offline asset policy, run by the acceptance sequence. The script runs
/// in the page through callAsyncJavaScript; `judge` lists failed expectations (empty = held).
enum AssetProbe {
  static let script = """
    const out = {};
    const probe = async (name, url, init) => {
      try {
        const r = await fetch(url, { cache: 'no-store', ...(init || {}) });
        out[name] = { status: r.status, type: r.headers.get('content-type'), coep: r.headers.get('cross-origin-embedder-policy'), nosniff: r.headers.get('x-content-type-options') };
      } catch (e) { out[name] = { error: String((e && e.name) || e) }; }
    };
    await probe('page', '/engine/page.html');
    await probe('wasm', '/engine/.scriptc/ui.wasm');
    await probe('module', '/engine/host.js');
    await probe('head', '/engine/host.js', { method: 'HEAD' });
    await probe('post', '/engine/host.js', { method: 'POST', body: 'x' });
    await probe('missing', '/engine/absent.js');
    await probe('traversal', '/engine/%2e%2e/%2e%2e/Info.plist');
    await probe('encoded', '/engine%2fpage.html');
    await probe('bundle', '/Info.plist');
    await probe('external', 'https://example.com/');
    out.isolated = self.crossOriginIsolated === true;
    out.reports = (window.engineDemo && window.engineDemo.reports) || [];
    return JSON.stringify(out);
    """

  /// Returns the list of failed expectations (empty when the policy held).
  static func judge(_ text: String?) -> [String] {
    guard let data = text?.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ["unparsed"] }
    func entry(_ key: String) -> [String: Any] { object[key] as? [String: Any] ?? [:] }
    func status(_ key: String) -> Int? { entry(key)["status"] as? Int }
    func type(_ key: String) -> String { entry(key)["type"] as? String ?? "" }
    var failed: [String] = []
    if status("page") != 200 || !type("page").hasPrefix("text/html") { failed.append("page") }
    if status("wasm") != 200 || type("wasm") != "application/wasm" { failed.append("wasm-mime") }
    if status("module") != 200 || !type("module").hasPrefix("text/javascript") { failed.append("module-mime") }
    if entry("module")["nosniff"] as? String != "nosniff" { failed.append("nosniff") }
    if status("head") != 200 { failed.append("head") }
    if let code = status("post"), code != 405 { failed.append("post") }
    if status("missing") != 404 { failed.append("missing") }
    for key in ["traversal", "encoded", "bundle"] { if let code = status(key), code < 400 { failed.append(key) } }
    if status("external") != nil { failed.append("external-reachable") }
    return failed
  }
}
