import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let device = UIDevice.current
    #if targetEnvironment(simulator)
    let kind = "simulator"
    #else
    let kind = "device"
    #endif
    Evidence.emit("NT_IOS_LAUNCH", "\(device.systemName) \(device.systemVersion) \(device.model) \(kind) acceptance=\(Acceptance.enabled)")
    _ = ControlLibrary.shared.start()
    return true
  }

  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default", sessionRole: session.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }

  func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
    Evidence.emit("NT_IOS_MEMORY_WARNING", "collected=\(ControlLibrary.shared.collect())")
  }

  func applicationWillTerminate(_ application: UIApplication) {
    Evidence.emit("NT_IOS_TERMINATE")
  }

  /// The native command surface: the same "change clear colour" command the desktop menu
  /// sends, available from the iPadOS menu bar and hardware keyboards (⌘K).
  override func buildMenu(with builder: UIMenuBuilder) {
    super.buildMenu(with: builder)
    guard builder.system == .main else { return }
    let command = UIKeyCommand(title: "Change Clear Colour", action: #selector(HostController.changeClearColour(_:)), input: "r", modifierFlags: .command)
    builder.insertSibling(UIMenu(title: "Engine", children: [command]), afterMenu: .view)
  }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private(set) var host: HostController?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    self.window = window
    mount()
    window.makeKeyAndVisible()
    if Acceptance.enabled { Acceptance.shared.begin(scene: self) }
  }

  func mount() {
    let host = HostController()
    host.observer = Acceptance.enabled ? Acceptance.shared : nil
    window?.rootViewController = host
    self.host = host
  }

  /// Dispose the current host and mount a fresh one; returns the old host weakly so callers can
  /// prove it was released.
  func remount() -> WeakBox<HostController> {
    let old = WeakBox(host)
    host?.dispose()
    host = nil
    mount()
    return old
  }

  func sceneDidEnterBackground(_ scene: UIScene) { host?.enterBackground() }
  func sceneWillEnterForeground(_ scene: UIScene) { host?.enterForeground() }
  func sceneDidDisconnect(_ scene: UIScene) {
    Evidence.emit("NT_IOS_LIFECYCLE", "disconnect")
    host?.dispose()
    host = nil
    window = nil
  }
}

final class WeakBox<T: AnyObject> {
  weak var value: T?
  init(_ value: T?) { self.value = value }
}

@MainActor protocol HostObserver: AnyObject {
  func hostDidLoadPage(_ host: HostController)
  func host(_ host: HostController, report: String)
  func host(_ host: HostController, delivered: Bool)
}

/// Breaks the WKUserContentController → handler → controller retain cycle.
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: HostController?
  init(_ target: HostController) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.receive(message)
  }
}

final class HostController: UIViewController, WKNavigationDelegate, WKUIDelegate, ControlLibraryDelegate {
  static let changeColourTopic: UInt32 = 1
  static let maxOutbox = 32
  static let maxConsolePerSecond = 120
  static let offlineRules = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^app://local/"},"action":{"type":"ignore-previous-rules"}}]
    """
  private static let consoleBridge = """
    (() => {
      const limit = 2048;
      const text = (x) => { try { return x instanceof Error ? (x.stack || x.message) : typeof x === 'object' ? JSON.stringify(x) : String(x); } catch (_) { return String(x); } };
      const post = (type, args) => { try { window.webkit.messageHandlers.ntConsole.postMessage((type + ' ' + args.map(text).join(' ')).slice(0, limit)); } catch (_) {} };
      for (const type of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = console[type].bind(console);
        console[type] = (...args) => { post(type, args); original(...args); };
      }
      addEventListener('error', (e) => post('uncaught', [e.message, (e.filename || '') + ':' + e.lineno + ':' + e.colno, e.error || '']));
      addEventListener('unhandledrejection', (e) => post('rejection', [e.reason]));
      addEventListener('securitypolicyviolation', (e) => post('csp', [e.violatedDirective, e.blockedURI]));
    })();
    """

  weak var observer: HostObserver?
  private let library = ControlLibrary.shared
  private var web: WKWebView?
  private var assets: AssetSchemeHandler?
  private var pageReady = false, foreground = true, disposed = false, delivering = false
  private var outbox: [Data] = []
  private var engineWindow = RateWindow(limit: EngineProtocol.maxRate)
  private var consoleWindow = RateWindow(limit: HostController.maxConsolePerSecond)
  private var commandWindow = RateWindow(limit: EngineProtocol.maxRate)
  private var rejectionWindow = RateWindow(limit: 8)
  private var terminations: [Date] = []
  private let commandButton = UIButton(type: .system)
  private let container = UIView()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(red: 0.06, green: 0.09, blue: 0.13, alpha: 1)
    library.delegate = self
    commandButton.setTitle("Change clear colour", for: .normal)
    commandButton.accessibilityIdentifier = "nt-change-colour"
    commandButton.addTarget(self, action: #selector(changeClearColour(_:)), for: .primaryActionTriggered)
    commandButton.isEnabled = false
    for item in [container, commandButton] as [UIView] { item.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(item) }
    let guide = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      container.topAnchor.constraint(equalTo: guide.topAnchor), container.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      container.trailingAnchor.constraint(equalTo: view.trailingAnchor), container.bottomAnchor.constraint(equalTo: commandButton.topAnchor, constant: -8),
      commandButton.centerXAnchor.constraint(equalTo: guide.centerXAnchor), commandButton.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -8),
      commandButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])
    WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "nt-offline-v1", encodedContentRuleList: Self.offlineRules) { [weak self] rules, error in
      DispatchQueue.main.async {
        guard let self, !self.disposed else { return }
        guard let rules else {
          Evidence.emit("NT_IOS_OFFLINE_POLICY_FAILED", error.map { String(describing: $0) } ?? "no rule list")
          return
        }
        self.createWebView(rules: rules)
      }
    }
  }

  private func createWebView(rules: WKContentRuleList) {
    let root = Bundle.main.resourceURL!.appendingPathComponent("engine-assets", isDirectory: true)
    let catalog = AssetCatalog(root: root)
    Evidence.emit(catalog == nil ? "NT_IOS_ASSETS_MISSING" : "NT_IOS_ASSETS", catalog.map { "files=\($0.paths.count) entry=\(AssetCatalog.entry)" } ?? root.path)
    guard catalog != nil else { return }
    let assets = AssetSchemeHandler(catalog: catalog)
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.setURLSchemeHandler(assets, forURLScheme: AssetCatalog.scheme)
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    config.dataDetectorTypes = []
    config.userContentController.add(rules)
    config.userContentController.add(WeakMessageHandler(self), name: "ntEngine")
    config.userContentController.add(WeakMessageHandler(self), name: "ntConsole")
    config.userContentController.addUserScript(WKUserScript(source: Self.consoleBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsLinkPreview = false
    #if DEBUG
    web.isInspectable = true
    #endif
    web.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(web)
    NSLayoutConstraint.activate([
      web.topAnchor.constraint(equalTo: container.topAnchor), web.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      web.leadingAnchor.constraint(equalTo: container.leadingAnchor), web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
    ])
    self.web = web
    self.assets = assets
    commandButton.isEnabled = library.started
    web.load(URLRequest(url: URL(string: AssetCatalog.origin + "/" + AssetCatalog.entry)!))
  }

  // MARK: page → native

  func receive(_ message: WKScriptMessage) {
    guard !disposed, let web, message.webView === web, message.frameInfo.isMainFrame,
      message.frameInfo.securityOrigin.protocol == AssetCatalog.scheme, message.frameInfo.securityOrigin.host == AssetCatalog.host,
      let text = message.body as? String else { reject("origin", message.name); return }
    switch message.name {
    case "ntConsole":
      guard consoleWindow.admit() else { return }
      Evidence.emit("NT_IOS_CONSOLE", text)
    case "ntEngine":
      guard engineWindow.admit() else { reject("rate", message.name); return }
      guard text.utf8.count <= EngineProtocol.maxEnvelope, let frame = EngineProtocol.decodeEnvelope(text) else { reject("envelope", message.name); return }
      let status = library.receive(frame: frame)
      if status != .accepted { reject("control-\(status.rawValue)", message.name) }
    default:
      reject("channel", message.name)
    }
  }

  private func reject(_ reason: String, _ channel: String) {
    guard rejectionWindow.admit() else { return }
    Evidence.emit("NT_IOS_MESSAGE_REJECTED", "\(channel) \(reason)")
  }

  func controlLibrary(_ library: ControlLibrary, inbound frame: Data) {
    guard !disposed, frame.count >= 16 else { return }
    let bytes = [UInt8](frame)
    let topic = (0..<4).reduce(UInt32(0)) { $0 | UInt32(bytes[8 + $1]) << ($1 * 8) }
    let payload = EngineProtocol.payload(frame)
    let text = String(data: payload, encoding: .utf8) ?? "binary \(payload.count) bytes"
    Evidence.emit("NT_IOS_ENGINE", "kind=\(bytes[1]) topic=\(topic) \(text)")
    markReady()
    observer?.host(self, report: text)
  }

  // MARK: native → page

  /// Emit a native command through the scriptc control library. The encoded frame arrives via
  /// the controlSend callback and is delivered to the page after the export returns.
  @discardableResult func sendCommand(topic: UInt32, payload: Data = Data()) -> ControlLibrary.Status {
    guard !disposed else { return .unavailable }
    guard commandWindow.admit() else { Evidence.emit("NT_IOS_COMMAND", "topic=\(topic) status=rate-limited"); return .busy }
    let status = library.command(topic: topic, payload: payload)
    Evidence.emit("NT_IOS_COMMAND", "topic=\(topic) status=\(status.rawValue)")
    return status
  }

  @objc func changeClearColour(_ sender: Any?) { sendCommand(topic: Self.changeColourTopic) }

  func controlLibrary(_ library: ControlLibrary, outbound frame: Data) {
    guard !disposed else { return }
    guard EngineProtocol.valid(frame), frame[2] == 0, frame[3] == 2 else { Evidence.emit("NT_IOS_COMMAND_INVALID", "\(frame.count) bytes"); return }
    guard outbox.count < Self.maxOutbox else { Evidence.emit("NT_IOS_COMMAND_DROPPED", "outbox full"); return }
    outbox.append(frame)
    flushOutbox()
  }

  private func markReady() {
    guard !pageReady else { return }
    pageReady = true
    flushOutbox()
  }

  private func flushOutbox() {
    guard pageReady, foreground, !disposed, !delivering, let web, let frame = outbox.first else { return }
    let encoded = frame.base64EncodedString()
    // Evaluated source contains only the fixed call and the base64 alphabet.
    guard encoded.utf8.allSatisfy({ ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 43 || $0 == 47 || $0 == 61 }) else { outbox.removeFirst(); return }
    delivering = true
    let source = "typeof window.__nt_engine_receive === \"function\" ? (window.__nt_engine_receive(\"\(encoded)\"), true) : false"
    web.evaluateJavaScript(source) { [weak self] result, error in
      guard let self else { return }
      self.delivering = false
      guard !self.disposed else { return }
      if let error {
        self.outbox.removeFirst()
        Evidence.emit("NT_IOS_COMMAND_FAILED", String(describing: error))
        self.observer?.host(self, delivered: false)
      } else if result as? Bool == true {
        self.outbox.removeFirst()
        Evidence.emit("NT_IOS_COMMAND_DELIVERED", "bytes=\(frame.count)")
        self.observer?.host(self, delivered: true)
      } else {
        self.pageReady = false
        Evidence.emit("NT_IOS_COMMAND_DEFERRED", "page receiver not installed")
        return
      }
      self.flushOutbox()
    }
  }

  // MARK: navigation and web content

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    let url = action.request.url
    let allowed = url?.scheme == AssetCatalog.scheme && url?.host == AssetCatalog.host
    if !allowed { Evidence.emit("NT_IOS_NAVIGATION_BLOCKED", url?.absoluteString ?? "<nil>") }
    decisionHandler(allowed ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Evidence.emit("NT_IOS_PAGE_LOADED", webView.url?.absoluteString ?? "")
    observer?.hostDidLoadPage(self)
    webView.evaluateJavaScript("typeof window.__nt_engine_receive === \"function\"") { [weak self] result, _ in
      if result as? Bool == true { self?.markReady() }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    Evidence.emit("NT_IOS_PAGE_FAILED", String(describing: error))
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    Evidence.emit("NT_IOS_PAGE_FAILED", "provisional " + String(describing: error))
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    pageReady = false
    delivering = false
    let now = Date()
    terminations = terminations.filter { now.timeIntervalSince($0) < 60 } + [now]
    if terminations.count <= 3 {
      Evidence.emit("NT_IOS_WEBCONTENT_TERMINATED", "reload attempt=\(terminations.count)")
      webView.reload()
    } else {
      Evidence.emit("NT_IOS_WEBCONTENT_GIVEUP", "\(terminations.count) terminations in 60 s")
    }
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    Evidence.emit("NT_IOS_NAVIGATION_BLOCKED", "window " + (action.request.url?.absoluteString ?? ""))
    return nil
  }

  // MARK: lifecycle

  func enterBackground() {
    foreground = false
    let collected = library.collect()
    Evidence.emit("NT_IOS_LIFECYCLE", "background outbox=\(outbox.count) collected=\(collected)")
  }

  func enterForeground() {
    foreground = true
    Evidence.emit("NT_IOS_LIFECYCLE", "foreground outbox=\(outbox.count)")
    flushOutbox()
  }

  override func didReceiveMemoryWarning() {
    super.didReceiveMemoryWarning()
    library.collect()
  }

  /// Detach every page channel and drop queued work. Idempotent.
  func dispose() {
    guard !disposed else { return }
    disposed = true
    outbox.removeAll()
    if library.delegate === self { library.delegate = nil }
    if let web {
      web.stopLoading()
      web.configuration.userContentController.removeAllScriptMessageHandlers()
      web.configuration.userContentController.removeAllUserScripts()
      web.configuration.userContentController.removeAllContentRuleLists()
      web.navigationDelegate = nil
      web.uiDelegate = nil
      web.removeFromSuperview()
    }
    assets?.cancelAll()
    web = nil
    assets = nil
    observer = nil
    Evidence.emit("NT_IOS_DISPOSED")
  }

  deinit { Evidence.emit("NT_IOS_HOST_RELEASED") }

  // MARK: acceptance probes

  func evaluate(_ body: String, completion: @escaping @MainActor (String?) -> Void) {
    guard let web, !disposed else { completion(nil); return }
    web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
      switch result {
      case .success(let value): completion(value as? String)
      case .failure(let error): completion("error " + String(describing: error))
      }
    }
  }
}
