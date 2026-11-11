import Foundation
import WebKit

#if os(iOS)
  import UIKit
#else
  import AppKit
  import PDFKit
#endif

// Uses the platform print formatter/operation, not a screen snapshot. That is
// important for @media print, pagination and page-break CSS.
final class HostPDFJob: NSObject, WKNavigationDelegate {
  private weak var source: WKWebView?
  private weak var presenter: HostPresenter?
  private var hidden: WKWebView?
  private let scheme: String, host: String
  private var completion: ((Result<URL?, Error>) -> Void)?
  private var timeout: DispatchWorkItem?
  private var printing = false
  private var restoreMedia: (() -> Void)?
  init(web: WKWebView, presenter: HostPresenter, scheme: String, host: String) {
    source = web
    self.presenter = presenter
    self.scheme = scheme
    self.host = host
  }
  func run(html: String?, printDocument: Bool, completion: @escaping (Result<URL?, Error>) -> Void)
    throws
  {
    guard let source else { throw hostError("page unavailable") }
    guard (html?.utf8.count ?? 0) <= 384 * 1024 else {
      throw hostError("HTML exceeds host request bound")
    }
    self.completion = completion
    printing = printDocument
    let timer = DispatchWorkItem { [weak self] in
      self?.finish(.failure(hostError("document render timed out", "timeout")))
    }
    timeout = timer
    DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: timer)
    if let html {
      let config = WKWebViewConfiguration()
      config.websiteDataStore = .nonPersistent()
      if let handler = source.configuration.urlSchemeHandler(forURLScheme: scheme) {
        config.setURLSchemeHandler(handler, forURLScheme: scheme)
      }
      let view = WKWebView(
        frame: CGRect(x: 0, y: 0, width: 595.28, height: 841.89), configuration: config)
      hidden = view
      view.navigationDelegate = self
      #if os(iOS)
        view.alpha = 0.01
        view.isUserInteractionEnabled = false
        presenter?.view.addSubview(view)
      #else
        view.alphaValue = 0.01
        presenter?.view.addSubview(view)
      #endif
      // No page bridge, scripts, remote assets, or external navigation in the
      // document renderer. Multiple CSPs intersect rather than relax this one.
      let policy =
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: \(scheme):; style-src 'unsafe-inline' \(scheme):; font-src \(scheme):; script-src 'none'\">"
      view.loadHTMLString(policy + html, baseURL: source.url)
    } else {
      ready(source)
    }
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = action.request.url
    decisionHandler(
      url?.absoluteString == "about:blank" || (url?.scheme == scheme && url?.host == host)
        ? .allow : .cancel)
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready(webView) }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    finish(.failure(error))
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) { finish(.failure(error)) }
  private func ready(_ web: WKWebView) {
    trace("ready")
    let originalMedia = web.mediaType
    web.mediaType = "print"
    restoreMedia = { [weak web] in web?.mediaType = originalMedia }
    web.callAsyncJavaScript(
      "await document.fonts.ready; await Promise.all(Array.from(document.images).map(i => i.complete ? Promise.resolve() : new Promise(r => { i.onload = r; i.onerror = r; }))); return true;",
      arguments: [:], in: nil, in: .page
    ) { [weak self] result in
      guard let self, self.completion != nil else { return }
      switch result {
      case .failure(let error): self.finish(.failure(error))
      case .success: self.render(web)
      }
    }
  }
  private func render(_ web: WKWebView) {
    trace("render")
    #if os(iOS)
      if printing {
        guard let presenter, presenter.viewIfLoaded?.window != nil else {
          finish(.failure(hostError("window unavailable")))
          return
        }
        let controller = UIPrintInteractionController.shared
        controller.printFormatter = web.viewPrintFormatter()
        controller.present(animated: true) { [weak self] _, completed, error in
          if let error {
            self?.finish(.failure(error))
          } else if completed {
            self?.finish(.success(nil))
          } else {
            self?.finish(.failure(hostError("cancelled", "cancelled")))
          }
        }
      } else {
        let renderer = HostPrintRenderer()
        renderer.addPrintFormatter(web.viewPrintFormatter(), startingAtPageAt: 0)
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: 1))
        let pages = renderer.numberOfPages
        guard pages > 0, pages <= 4096 else {
          finish(.failure(hostError("invalid PDF page count", "quota")))
          return
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
          UUID().uuidString + ".pdf")
        do {
          try UIGraphicsPDFRenderer(bounds: renderer.paperRect).writePDF(to: url) { context in
            for page in 0..<pages {
              context.beginPage()
              renderer.drawPage(at: page, in: renderer.paperRect)
            }
          }
          finish(.success(url))
        } catch {
          try? FileManager.default.removeItem(at: url)
          finish(.failure(error))
        }
      }
    #else
      do {
        // createPDF is asynchronous and bounded. In recent WebKit builds an
        // offscreen NSPrintOperation can report NSIntegerMax pages and spool
        // indefinitely. Explicit print media preserves @media print without
        // using that unsafe page-count path. The PDF is a continuous document.
        web.evaluateJavaScript(
          "({width:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0),height:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)})"
        ) { [weak self] value, error in
          guard let self, self.completion != nil else { return }
          if let error {
            self.finish(.failure(error))
            return
          }
          guard let bounds = value as? [String: Double], let width = bounds["width"],
            let height = bounds["height"], width.isFinite, height.isFinite, width > 0, height > 0,
            width <= 16384, height <= 1_000_000
          else {
            self.finish(.failure(hostError("PDF dimensions exceed bounds", "quota")))
            return
          }
          let configuration = WKPDFConfiguration()
          configuration.rect = CGRect(x: 0, y: 0, width: width, height: height)
          web.createPDF(configuration: configuration) { [weak self] result in
            guard let self, self.completion != nil else { return }
            switch result {
            case .failure(let error): self.finish(.failure(error))
            case .success(let data):
              guard data.count <= ArchiveStore.maxFile else {
                self.finish(.failure(hostError("PDF exceeds size bound", "quota")))
                return
              }
              if self.printing {
                guard let document = PDFDocument(data: data), let page = document.page(at: 0) else {
                  self.finish(.failure(hostError("invalid print PDF")))
                  return
                }
                let info = NSPrintInfo.shared.copy() as! NSPrintInfo
                let view = HostPDFPrintView(page: page, info: info)
                let operation = NSPrintOperation(view: view, printInfo: info)
                operation.showsPrintPanel = true
                operation.showsProgressPanel = true
                let ok = operation.run()
                self.finish(
                  ok ? .success(nil) : .failure(hostError("print cancelled", "cancelled")))
                return
              }
              let temporary =
                CommandLine.arguments.contains("--host-selftest")
                ? URL(
                  fileURLWithPath: ProcessInfo.processInfo.environment["NT_HOST_ARCHIVE_ROOT"]
                    ?? NSTemporaryDirectory()) : FileManager.default.temporaryDirectory
              let output = temporary.appendingPathComponent(
                "nt-document-" + UUID().uuidString + ".pdf")
              do {
                try data.write(to: output, options: .atomic)
                self.finish(.success(output))
              } catch {
                try? FileManager.default.removeItem(at: output)
                self.finish(.failure(error))
              }
            }
          }
        }
      }
    #endif
  }
  private func trace(_ phase: String) {
    if CommandLine.arguments.contains("--host-selftest") {
      FileHandle.standardOutput.write(Data("NT_PDF \(phase)\n".utf8))
    }
  }
  private func finish(_ result: Result<URL?, Error>) {
    guard let done = completion else { return }
    completion = nil
    timeout?.cancel()
    timeout = nil
    restoreMedia?()
    restoreMedia = nil
    hidden?.stopLoading()
    hidden?.navigationDelegate = nil
    hidden?.removeFromSuperview()
    hidden = nil
    done(result)
  }
  func cancel() {
    #if os(iOS)
      if printing { UIPrintInteractionController.shared.dismiss(animated: false) }
    #endif
    finish(.failure(hostError("document render cancelled", "cancelled")))
  }
}
#if os(iOS)
  private final class HostPrintRenderer: UIPrintPageRenderer {
    override var paperRect: CGRect { CGRect(x: 0, y: 0, width: 595.28, height: 841.89) }
    override var printableRect: CGRect { paperRect.insetBy(dx: 24, dy: 24) }
  }
#endif

#if os(macOS)
  // Print a finite snapshot, not WKPrintingView's potentially unbounded range.
  // Pagination clips the continuous print-media layout into the chosen paper.
  private final class HostPDFPrintView: NSView {
    private let page: PDFPage
    private let info: NSPrintInfo
    private var scale: CGFloat = 1, pageHeight: CGFloat = 1
    init(page: PDFPage, info: NSPrintInfo) {
      self.page = page
      self.info = info
      super.init(frame: .zero)
      layoutForPrint()
    }
    required init?(coder: NSCoder) { fatalError("not supported") }
    private func layoutForPrint() {
      let settings = NSPrintOperation.current?.printInfo ?? info
      let width = max(1, settings.paperSize.width - settings.leftMargin - settings.rightMargin)
      pageHeight = max(1, settings.paperSize.height - settings.topMargin - settings.bottomMargin)
      let bounds = page.bounds(for: .mediaBox)
      scale = min(1, width / max(1, bounds.width))
      setFrameSize(NSSize(width: width, height: max(1, bounds.height * scale)))
    }
    override func knowsPageRange(_ range: NSRangePointer) -> Bool {
      layoutForPrint()
      range.pointee = NSRange(
        location: 1, length: min(4096, max(1, Int(ceil(frame.height / pageHeight)))))
      return true
    }
    override func rectForPage(_ page: Int) -> NSRect {
      NSRect(
        x: 0, y: max(0, frame.height - CGFloat(page) * pageHeight), width: frame.width,
        height: min(pageHeight, frame.height - CGFloat(page - 1) * pageHeight))
    }
    override func draw(_ dirtyRect: NSRect) {
      guard let context = NSGraphicsContext.current?.cgContext else { return }
      context.saveGState()
      context.scaleBy(x: scale, y: scale)
      page.draw(with: .mediaBox, to: context)
      context.restoreGState()
    }
  }
#endif
