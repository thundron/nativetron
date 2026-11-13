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
  private var logTimes: [TimeInterval] = [], geometryTimes: [TimeInterval] = []
  private let flags = MacHostFlags(CommandLine.arguments)
  private var gpu: NativeGPUBridge?, surface: NativeGPUSurfaceHost?, router: MacSchemeRouter?
  private var dev: DevContentRoot?
  private var nextLoad: (() -> Void)?
  func applicationDidFinishLaunching(_ notification: Notification) {
    Evidence.emit("NT_MACOS_LAUNCHED")
    let root = Bundle.main.resourceURL!.appendingPathComponent("engine-assets")
    guard let catalog = AssetCatalog(root: root) else {
      Evidence.emit("NT_MACOS_ASSETS_MISSING", root.path)
      NSApp.terminate(nil)
      return
    }
    if let problem = flags.problem {
      Evidence.emit("NT_MACOS_FLAGS_REFUSED", problem)
      exit(2)
    }
    if let url = flags.devURL {
      switch DevContentRoot.validate(url) {
      case .success(let root): dev = root
      case .failure(let error):
        Evidence.emit("NT_MACOS_URL_REFUSED", error.description)
        exit(2)
      }
    }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let router = MacSchemeRouter(assets: AssetSchemeHandler(catalog: catalog))
    router.dev = dev
    self.router = router
    configuration.setURLSchemeHandler(router, forURLScheme: AssetCatalog.scheme)
    if flags.nativeGPU {
      var options = NativeGPUBridgeOptions()
      options.composition = flags.composition.wire
      if flags.selftest == "wire" { options.api = .recorder }
      let bridge = NativeGPUBridge(options: options)
      if flags.selftest == "wire" && !installNativeGPUWireSelfTest(bridge) {
        Evidence.emit("NT_NATIVE_GPU_SELFTEST_FAIL", "wire self-test resources missing")
        exit(1)
      }
      router.gpu = bridge
      gpu = bridge
      // Explicit selection before any canvas/probe: the page sees the offer and claims a session.
      configuration.userContentController.addUserScript(
        WKUserScript(
          source:
            "Object.defineProperty(window,'__ntNativeGpuOffer',{value:Object.freeze({endpoint:'\(NativeGPUBridge.prefix)'}),configurable:false,writable:false})",
          injectionTime: .atDocumentStart, forMainFrameOnly: true))
      configuration.userContentController.add(self, name: "ntGpuSurface")
      Evidence.emit(
        "NT_MACOS_NATIVE_GPU",
        "executor=\(options.api.name) composition=\(options.composition) linkage=\(NativeGPUExecutorAPI.linkage)")
      if NativeGPUExecutorAPI.linkage == "unlinked" && options.api.name == "unlinked" {
        Evidence.emit("NT_MACOS_NATIVE_GPU_PENDING_EXECUTOR_LINK", "rebuild with NT_GPU_EXECUTOR_LIBS=<executor archive + deps>")
      }
    }
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.userContentController.add(self, name: "ntEngine")
    configuration.userContentController.add(self, name: "ntConsole")
    configuration.userContentController.addUserScript(
      WKUserScript(
        source:
          "for(const key of ['log','info','warn','error']){const original=console[key].bind(console);console[key]=(...args)=>{original(...args);try{webkit.messageHandlers.ntConsole.postMessage(args.map(String).join(' ').slice(0,4096))}catch{}}}",
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let view = WKWebView(
      frame: CGRect(origin: .zero, size: flags.benchmarkViewport ?? CGSize(width: 1100, height: 760)),
      configuration: configuration)
    let controller = NSViewController()
    if flags.nativeGPU && flags.composition != .none {
      // The surface sits next to the web view inside a plain container; the web view tracks its bounds.
      let container = NSView(frame: view.frame)
      view.autoresizingMask = [.width, .height]
      container.addSubview(view)
      if let size = flags.benchmarkViewport { NativeGPUBenchmark.pin(view, size: size, in: container) }
      controller.view = container
      if flags.composition == .underlaySPI {
        // QUARANTINED: private WebKit SPI (KVC drawsBackground -> _setDrawsBackground:). Public macOS API keeps
        // WKWebView opaque (measured: takeSnapshot/window alpha 1 with transparent html/body and
        // underPageBackgroundColor = .clear). Not shippable; explicit experimental opt-in only.
        view.setValue(false, forKey: "drawsBackground")
        Evidence.emit(
          "NT_MACOS_NATIVE_GPU_POLICY_BLOCKER",
          "underlay uses private WebKit SPI drawsBackground; experimental opt-in only, not for shipping")
      } else {
        Evidence.emit(
          "NT_MACOS_NATIVE_GPU_COMPOSITION",
          "overlay: native layer above the web view masked by reported DOM rects; rounded/translucent DOM over the canvas does not blend with the scene")
      }
    } else {
      controller.view =
        flags.benchmarkViewport.map { NativeGPUBenchmark.container(pinning: view, size: $0) } ?? view
      if flags.nativeGPU {
        Evidence.emit(
          "NT_MACOS_NATIVE_GPU_PRESENTATION_BLOCKED",
          "no composition selected: public WKWebView cannot be transparent on macOS; executor runs headless. Pass --native-gpu-composition=overlay or the experimental underlay-spi")
      }
    }
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
    if let gpu, flags.composition != .none {
      let host = NativeGPUSurfaceHost(
        webView: view, composition: flags.composition == .overlay ? .overlay : .underlay(webViewTransparent: true),
        pageZoom: { [weak view] in Double(view?.pageZoom ?? 1) },
        magnification: { [weak view] in Double(view?.magnification ?? 1) },
        enqueue: { [weak gpu] event in gpu?.surfaceEvent(event) })
      gpu.surface = host
      surface = host
    }
    if flags.selftest == "composition" {
      window.orderFrontRegardless()  // composited pixels need an on-screen, unoccluded window (no activation)
      surface?.attach()
    } else if CommandLine.arguments.contains("--host-selftest") || flags.selftest != nil
      || CommandLine.arguments.contains("--no-activate")
    {
      // Automated runs never take keyboard focus from the user.
      surface?.attach()
      window.orderBack(nil)
    } else {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      surface?.attach()
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
      if let dev = self.dev {
        Evidence.emit("NT_MACOS_DEV_CONTENT", dev.root.path)
        view.load(URLRequest(url: URL(string: "\(AssetCatalog.scheme)://\(DevContentRoot.host)/\(dev.entry)")!))
      } else if self.flags.selftest == "wire" {
        view.load(URLRequest(url: URL(string: AssetCatalog.origin + NativeGPUBridge.prefix + "selftest.html")!))
      } else {
        view.load(URLRequest(url: URL(string: AssetCatalog.origin + "/" + AssetCatalog.entry)!))
      }
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
      self.surface?.invalidate()
      self.gpu?.shutdown()
      self.services?.dispose()
      self.services = nil
      self.web?.configuration.userContentController.removeScriptMessageHandler(forName: "ntEngine")
      self.web?.configuration.userContentController.removeScriptMessageHandler(forName: "ntConsole")
      if self.gpu != nil {
        self.web?.configuration.userContentController.removeScriptMessageHandler(forName: "ntGpuSurface")
      }
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
    if message.name == "ntGpuSurface" {
      // Geometry only (no capability): main frame of the current page origin, bounded rate.
      guard let gpu, message.webView === web, message.frameInfo.isMainFrame,
        message.frameInfo.securityOrigin.protocol == AssetCatalog.scheme,
        message.frameInfo.securityOrigin.host == web?.url?.host
      else { return }
      let now = ProcessInfo.processInfo.systemUptime
      geometryTimes.removeAll { now - $0 >= 1 }
      guard geometryTimes.count < 240 else { return }
      geometryTimes.append(now)
      gpu.geometry(message.body)
      return
    }
    // Console evidence is also accepted from the owner-local dev origin (logging only); the engine/host-service
    // handlers below stay bound to app://local.
    let devConsole =
      message.name == "ntConsole" && dev != nil && message.frameInfo.securityOrigin.host == DevContentRoot.host
    guard message.webView === web, message.frameInfo.isMainFrame,
      message.frameInfo.securityOrigin.protocol == AssetCatalog.scheme,
      message.frameInfo.securityOrigin.host == AssetCatalog.host || devConsole
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
    let url = action.request.url
    let allowed =
      url?.scheme == AssetCatalog.scheme
      && (url?.host == AssetCatalog.host || (dev != nil && url?.host == DevContentRoot.host))
    if allowed, action.targetFrame?.isMainFrame ?? true {
      // A new main document ends every native GPU generation and capability of the previous one.
      gpu?.reset(origin: url)
    }
    decisionHandler(allowed ? .allow : .cancel)
  }
  func webView(_ view: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    services?.reset()
  }
  func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
    Evidence.emit("NT_MACOS_PAGE_LOADED", view.url?.absoluteString ?? "")
    if flags.benchmarkViewport != nil { NativeGPUBenchmark.report(view, window: window) }
    if let hook = nextLoad {
      nextLoad = nil
      hook()
    }
    if let mode = flags.selftest, !selftestStarted, let gpu {
      selftestStarted = true
      runNativeGPUSelfTest(
        mode: mode, web: view, bridge: gpu, surface: surface,
        onNextLoad: { [weak self] hook in self?.nextLoad = hook }
      ) { [weak self] status, message in
        Evidence.emit(status.evidence, message)
        self?.surface?.invalidate()
        self?.gpu?.shutdown()
        self?.services?.dispose()
        self?.services = nil
        exit(status.code)
      }
    }
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
    gpu?.reset(origin: nil)
    if !closing { view.reload() }
  }
  func webView(
    _ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? { nil }
}

/// Command-line switches for the macOS host. Native GPU is opt-in; JS WebGPU stays the default.
///   --native-gpu                         offer the native executor to the page (explicit selection)
///   --native-gpu-composition=MODE        none (headless execution, default) | overlay | underlay-spi (experimental)
///   --native-gpu-selftest=e2e|wire|composition   opt-in self-tests (implies --native-gpu)
///   --url file:///tmp/<dir>/<page>.html  owner-local read-only content served as app://dev
///   --no-activate                        keep the window behind others without taking focus (measurement runs)
///   --benchmark-viewport=WxH             fixed web view size in points (benchmark runs; NativeGPUBenchmark.swift)
struct MacHostFlags {
  enum Composition: Equatable {
    case none, overlay, underlaySPI
    var wire: String { self == .none ? "none" : self == .overlay ? "overlay" : "underlay" }
  }
  var nativeGPU = false
  var composition = Composition.none
  var selftest: String?
  var devURL: String?
  var benchmarkViewport: CGSize?
  var problem: String?
  init(_ arguments: [String]) {
    var index = 1
    while index < arguments.count {
      let argument = arguments[index]
      let value = argument.split(separator: "=", maxSplits: 1).dropFirst().first.map(String.init)
      if argument == "--native-gpu" { nativeGPU = true }
      else if argument.hasPrefix("--native-gpu-composition=") {
        switch value {
        case "none": composition = .none
        case "overlay": composition = .overlay
        case "underlay-spi": composition = .underlaySPI
        default: problem = "unknown --native-gpu-composition \(value ?? "")"
        }
      } else if argument.hasPrefix("--native-gpu-selftest=") {
        guard let value, ["e2e", "wire", "composition"].contains(value) else { problem = "unknown --native-gpu-selftest"; break }
        selftest = value; nativeGPU = true
      } else if argument == "--url", index + 1 < arguments.count { devURL = arguments[index + 1]; index += 1 }
      else if argument.hasPrefix(NativeGPUBenchmark.flag) {
        benchmarkViewport = NativeGPUBenchmark.parseViewport(value)
        if benchmarkViewport == nil { problem = "bad \(argument) (WxH, 200...8192 points)" }
      }
      index += 1
    }
    if selftest == "composition" && composition == .none { problem = "--native-gpu-selftest=composition needs --native-gpu-composition" }
    if composition != .none && !nativeGPU { problem = "--native-gpu-composition requires --native-gpu" }
  }
}
