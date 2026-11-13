import AppKit
import WebKit

/// Benchmark-only host switch (gpu/native/benchmark/): `--benchmark-viewport=WxH` pins the web view to a fixed
/// size in points, independent of the window. Tiling window managers resize new windows to their layout (measured:
/// AeroSpace gave the 1100×760 window 1728×1051 or 864×1051 points from run to run), which changes the page layout,
/// the engine canvas and therefore every per-frame cost; the compared Chrome path emulates the same CSS viewport.
/// The web view keeps its top-left corner; a smaller window clips it (reported, the page size never changes).
enum NativeGPUBenchmark {
  static let flag = "--benchmark-viewport="

  /// "1100x760" → size (both 200…8192 points), else nil.
  static func parseViewport(_ text: String?) -> CGSize? {
    guard let parts = text?.split(separator: "x"), parts.count == 2,
      let width = Int(parts[0]), let height = Int(parts[1]),
      (200...8192).contains(width), (200...8192).contains(height)
    else { return nil }
    return CGSize(width: width, height: height)
  }

  /// Fixed-size, top-left anchored web view inside `container` (non-flipped: anchored to the top edge).
  static func pin(_ view: WKWebView, size: CGSize, in container: NSView) {
    view.autoresizingMask = [.maxXMargin, .minYMargin]
    view.frame = CGRect(x: 0, y: container.bounds.height - size.height, width: size.width, height: size.height)
  }

  /// A container for the pinned web view when the host would otherwise use the web view as the window content.
  static func container(pinning view: WKWebView, size: CGSize) -> NSView {
    let container = NSView(frame: CGRect(origin: .zero, size: size))
    container.addSubview(view)
    pin(view, size: size, in: container)
    return container
  }

  static func report(_ view: WKWebView, window: NSWindow?) {
    let content = window?.contentView?.bounds.size ?? .zero
    let visible = view.visibleRect.size
    Evidence.emit(
      "NT_MACOS_BENCHMARK_VIEWPORT",
      "web=\(Int(view.frame.width))x\(Int(view.frame.height)) window=\(Int(content.width))x\(Int(content.height)) visible=\(Int(visible.width))x\(Int(visible.height)) backing=\(window?.backingScaleFactor ?? 0)"
    )
  }
}
