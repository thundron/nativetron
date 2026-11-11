import AppKit
import WebKit

@main struct MacHost {
  @MainActor static func main() {
    Evidence.emit("NT_MACOS_START")
    let app = NSApplication.shared
    let delegate = MacHostDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) {
      app.finishLaunching()
      app.run()
    }
  }
}

@MainActor
final class MacHostDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
  WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler
{
  private var window: NSWindow?, web: WKWebView?, services: HostServices?
  private var closing = false, disposed = false, selftestStarted = false
  private var logTimes: [TimeInterval] = []
  func applicationDidFinishLaunching(_ notification: Notification) {
    Evidence.emit("NT_MACOS_LAUNCHED")
    let root = Bundle.main.resourceURL!.appendingPathComponent("engine-assets")
    guard let catalog = AssetCatalog(root: root) else {
      Evidence.emit("NT_MACOS_ASSETS_MISSING", root.path)
      NSApp.terminate(nil)
      return
    }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.setURLSchemeHandler(
      AssetSchemeHandler(catalog: catalog), forURLScheme: AssetCatalog.scheme)
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.userContentController.add(self, name: "ntEngine")
    configuration.userContentController.add(self, name: "ntConsole")
    configuration.userContentController.addUserScript(
      WKUserScript(
        source:
          "for(const key of ['log','info','warn','error']){const original=console[key].bind(console);console[key]=(...args)=>{original(...args);try{webkit.messageHandlers.ntConsole.postMessage(args.map(String).join(' ').slice(0,4096))}catch{}}}",
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let view = WKWebView(
      frame: CGRect(x: 0, y: 0, width: 1100, height: 760), configuration: configuration)
    let controller = NSViewController()
    controller.view = view
    services = HostServices(
      web: view, presenter: controller, scheme: AssetCatalog.scheme, host: AssetCatalog.host)
    view.navigationDelegate = self
    view.uiDelegate = self
    web = view
    let window = NSWindow(contentViewController: controller)
    window.title = "nativetron"
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    window.delegate = self
    self.window = window
    let menu = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "Quit nativetron", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    appItem.submenu = appMenu
    menu.addItem(appItem)
    let engineItem = NSMenuItem(title: "Engine", action: nil, keyEquivalent: "")
    let engineMenu = NSMenu(title: "Engine")
    let colour = NSMenuItem(
      title: "Change Clear Colour", action: #selector(changeColour), keyEquivalent: "r")
    colour.target = self
    engineMenu.addItem(colour)
    engineItem.submenu = engineMenu
    menu.addItem(engineItem)
    NSApp.mainMenu = menu
    window.center()
    if CommandLine.arguments.contains("--host-selftest") {
      window.orderBack(nil)
    } else {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }
    // The offline rule applies to subresources as well as navigation. Native
    // host services are a separate capability broker, never a network bypass.
    let rules = "[{\"trigger\":{\"url-filter\":\"^https?://\"},\"action\":{\"type\":\"block\"}}]"
    WKContentRuleListStore.default().compileContentRuleList(
      forIdentifier: "nt-macos-offline", encodedContentRuleList: rules
    ) { [weak self] list, error in
      guard let self, !self.closing, let list else {
        Evidence.emit("NT_MACOS_OFFLINE_POLICY_FAILED", String(describing: error))
        return
      }
      view.configuration.userContentController.add(list)
      view.load(URLRequest(url: URL(string: AssetCatalog.origin + "/" + AssetCatalog.entry)!))
    }
  }
  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls { HostServices.open(url) }
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if closing || window == nil { return .terminateNow }
    window?.performClose(nil)
    return .terminateCancel
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if closing { return true }
    closing = true
    let finish: @MainActor @Sendable () -> Void = { [weak self] in
      guard let self, !self.disposed else { return }
      self.disposed = true
      self.services?.dispose()
      self.services = nil
      self.web?.configuration.userContentController.removeScriptMessageHandler(forName: "ntEngine")
      self.web?.configuration.userContentController.removeScriptMessageHandler(forName: "ntConsole")
      self.web?.stopLoading()
      self.web?.navigationDelegate = nil
      self.web?.uiDelegate = nil
      sender.close()
    }
    web?.callAsyncJavaScript(
      "await window.__nt_engine_dispose?.(); return true;", arguments: [:], in: nil, in: .page
    ) { _ in finish() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: finish)
    return false
  }
  @objc private func changeColour() {
    guard !closing, let data = EngineProtocol.command(topic: 1),
      let envelope = EngineProtocol.envelope(data),
      let object = try? JSONSerialization.jsonObject(with: Data(envelope.utf8)) as? [String: Any],
      let base64 = object["frame"] as? String
    else { return }
    web?.evaluateJavaScript("window.__nt_engine_receive?.(\"\(base64)\")", completionHandler: nil)
  }
  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.webView === web, message.frameInfo.isMainFrame,
      message.frameInfo.securityOrigin.protocol == AssetCatalog.scheme,
      message.frameInfo.securityOrigin.host == AssetCatalog.host
    else { return }
    let now = ProcessInfo.processInfo.systemUptime
    logTimes.removeAll { now - $0 >= 1 }
    guard logTimes.count < 60 else { return }
    logTimes.append(now)
    if message.name == "ntConsole", let text = message.body as? String {
      Evidence.emit("NT_MACOS_CONSOLE", String(text.prefix(4096)))
      return
    }
    guard message.frameInfo.isMainFrame,
      message.frameInfo.securityOrigin.protocol == AssetCatalog.scheme,
      message.frameInfo.securityOrigin.host == AssetCatalog.host,
      let text = message.body as? String, let bytes = EngineProtocol.decodeEnvelope(text),
      EngineProtocol.fromEngineToNative(bytes)
    else { return }
    Evidence.emit(
      "NT_MACOS_ENGINE", String(data: EngineProtocol.payload(bytes), encoding: .utf8) ?? "binary")
  }
  func webView(
    _ view: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    decisionHandler(
      action.request.url?.scheme == AssetCatalog.scheme
        && action.request.url?.host == AssetCatalog.host ? .allow : .cancel)
  }
  func webView(_ view: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    services?.reset()
  }
  func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
    Evidence.emit("NT_MACOS_PAGE_LOADED", view.url?.absoluteString ?? "")
    if CommandLine.arguments.contains("--host-selftest") && !selftestStarted {
      selftestStarted = true
      runHostSelfTest(view) { [weak self] ok, message in
        Evidence.emit(ok ? "NT_HOST_SERVICES_PASS" : "NT_HOST_SERVICES_FAIL", message)
        self?.services?.dispose()
        self?.services = nil
        exit(ok ? 0 : 1)
      }
    }
  }
  func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
    services?.reset()
    if !closing { view.reload() }
  }
  func webView(
    _ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? { nil }
}
