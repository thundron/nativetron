import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = HostController()
    window.makeKeyAndVisible()
    self.window = window
    return true
  }
}

final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: HostController?
  init(_ target: HostController) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

final class HostController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
  private var web: WKWebView!
  private var windowStart = Date(), messageCount = 0
  override func viewDidLoad() {
    super.viewDidLoad()
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(Assets(), forURLScheme: "app")
    config.userContentController.add(WeakMessageHandler(self), name: "ntEngine")
    config.userContentController.add(WeakMessageHandler(self), name: "ntConsole")
    config.userContentController.addUserScript(WKUserScript(source: """
      (() => {
        const post = (type, args) => webkit.messageHandlers.ntConsole.postMessage(type + ' ' + args.map(x => String(x)).join(' '));
        for (const type of ['log', 'info', 'warn', 'error']) {
          const original = console[type].bind(console);
          console[type] = (...args) => { post(type, args); original(...args); };
        }
        addEventListener('error', e => post('uncaught', [e.message, e.filename, e.lineno]));
        addEventListener('unhandledrejection', e => post('rejection', [e.reason]));
      })();
      """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.isInspectable = true
    web.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(web)
    NSLayoutConstraint.activate([
      web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
    ])
    web.load(URLRequest(url: URL(string: "app://local/engine/page.html")!))
  }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "app", message.frameInfo.securityOrigin.host == "local", let text = message.body as? String else { return }
    if Date().timeIntervalSince(windowStart) >= 1 { windowStart = Date(); messageCount = 0 }
    messageCount += 1
    guard messageCount <= EngineProtocol.maxRate, text.utf8.count <= EngineProtocol.maxEnvelope else { return }
    if message.name == "ntConsole" { NSLog("nt-console %@", text); return }
    guard let bytes = EngineProtocol.decodeEnvelope(text), EngineProtocol.fromEngineToNative(bytes) else { return }
    NSLog("nt-engine %@", String(data: EngineProtocol.payload(bytes), encoding: .utf8) ?? "binary control message")
  }
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let url = navigationAction.request.url
    decisionHandler(url?.scheme == "app" && url?.host == "local" ? .allow : .cancel)
  }
  deinit {
    web?.configuration.userContentController.removeScriptMessageHandler(forName: "ntEngine")
    web?.configuration.userContentController.removeScriptMessageHandler(forName: "ntConsole")
  }
}

final class Assets: NSObject, WKURLSchemeHandler {
  private let root = Bundle.main.resourceURL!.appendingPathComponent("engine-assets", isDirectory: true).resolvingSymlinksInPath()
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, url.scheme == "app", url.host == "local" else {
      task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL)); return
    }
    let path = url.path.isEmpty || url.path == "/" ? "/engine/page.html" : url.path
    let file = root.appendingPathComponent(String(path.drop(while: { $0 == "/" }))).resolvingSymlinksInPath()
    let data = file.path.hasPrefix(root.path + "/") ? try? Data(contentsOf: file) : nil
    let types = ["wasm": "application/wasm", "js": "text/javascript", "mjs": "text/javascript", "html": "text/html", "json": "application/json", "css": "text/css"]
    task.didReceive(HTTPURLResponse(url: url, statusCode: data == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: [
      "Content-Type": types[file.pathExtension] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp"
    ])!)
    if let data { task.didReceive(data) }
    task.didFinish()
  }
  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
