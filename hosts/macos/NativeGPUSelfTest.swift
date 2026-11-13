import AppKit
import Foundation
@preconcurrency import WebKit

/// Exit status of the opt-in native GPU self-tests. `pendingExecutor` is never a pass: the crossing reached the
/// executor C API but this build links the unlinked stub, so nothing was executed.
enum NativeGPUSelfTestStatus {
  case pass, pendingExecutor, fail
  var evidence: String {
    switch self {
    case .pass: return "NT_NATIVE_GPU_SELFTEST_PASS"
    case .pendingExecutor: return "NT_NATIVE_GPU_SELFTEST_PENDING_EXECUTOR_LINK"
    case .fail: return "NT_NATIVE_GPU_SELFTEST_FAIL"
    }
  }
  var code: Int32 { self == .pass ? 0 : self == .pendingExecutor ? 3 : 1 }
}

/// Test-only routes for --native-gpu-selftest=wire, read from Contents/Resources/native-gpu-selftest.
@MainActor func installNativeGPUWireSelfTest(_ bridge: NativeGPUBridge) -> Bool {
  guard let root = Bundle.main.resourceURL?.appendingPathComponent("native-gpu-selftest"),
    let page = try? Data(contentsOf: root.appendingPathComponent("native-gpu-wire-selftest.html")),
    let worker = try? Data(contentsOf: root.appendingPathComponent("native-gpu-wire-selftest.js"))
  else { return false }
  bridge.testRoutes["selftest.html"] = ("text/html; charset=utf-8", page)
  bridge.testRoutes["selftest-worker.js"] = ("text/javascript; charset=utf-8", worker)
  return true
}

private func json(_ value: Any) -> String {
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  else { return String(describing: value) }
  return String(decoding: data, as: UTF8.self)
}

@MainActor func runNativeGPUSelfTest(
  mode: String, web: WKWebView, bridge: NativeGPUBridge, surface: NativeGPUSurfaceHost?,
  onNextLoad: @escaping (@escaping () -> Void) -> Void,
  done: @escaping (NativeGPUSelfTestStatus, String) -> Void
) {
  var finished = false
  let finish: (NativeGPUSelfTestStatus, String) -> Void = { status, message in
    guard !finished else { return }
    finished = true
    done(status, message)
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + 120) { finish(.fail, "native GPU self-test timed out") }
  switch mode {
  case "wire": wireSelfTest(web: web, bridge: bridge, finish: finish)
  default:
    e2eSelfTest(web: web, bridge: bridge, composition: mode == "composition" ? surface : nil, onNextLoad: onNextLoad, finish: finish)
  }
}

@MainActor private func wireSelfTest(web: WKWebView, bridge: NativeGPUBridge, finish: @escaping (NativeGPUSelfTestStatus, String) -> Void) {
  let script = """
    for (let i = 0; !window.__ntWireSelftest && i < 200; i++) await new Promise((r) => setTimeout(r, 25));
    if (!window.__ntWireSelftest) return { error: 'wire self-test page did not start' };
    try { return await window.__ntWireSelftest; } catch (error) { return { error: String(error) + ' @ ' + (error?.stack ?? '') }; }
    """
  web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
    switch result {
    case .failure(let error): finish(.fail, "wire self-test: \(error.localizedDescription)")
    case .success(let value):
      guard let object = value as? [String: Any], let checks = object["checks"] as? [[String: Any]] else {
        finish(.fail, "wire self-test returned no checks: \(String(describing: value)) native=\(json(bridge.stats.snapshot()))"); return
      }
      let native = bridge.stats.snapshot()
      var all = checks.map { ($0["name"] as? String ?? "?", ($0["ok"] as? Bool) ?? false) }
      // Native side of the same crossing: what the bridge consumed and returned.
      all.append(("native: 6 submissions consumed and acknowledged", native["submissions"] == 6 && native["acks"] == 6))
      all.append(("native: >= 9 MiB uploads consumed", (native["uploadBytes"] ?? 0) >= Double(9 * 1_048_576 + 3)))
      all.append(("native: multi-chunk sections reassembled natively", (native["reassemblyCopies"] ?? 0) >= 3))
      all.append(("native: single-chunk sections passed without a copy", (native["zeroCopySections"] ?? 0) >= 6))
      all.append(("native: 6 MiB readback left in bounded chunks", (native["readbackBytes"] ?? 0) >= Double(6 * 1_048_576)))
      all.append(("native: two executors created and destroyed", native["executorsCreated"] == 2 && (native["executorsDestroyed"] ?? 0) >= 1))
      let failed = all.filter { !$0.1 }.map(\.0)
      let report = json([
        "executor": "recorder (test double: hashes and echoes, executes nothing)",
        "checks": all.map { ["name": $0.0, "ok": $0.1] }, "native": native,
        "js": object["stats"] ?? [], "timings": object["timings"] ?? [:],
      ] as [String: Any])
      finish(failed.isEmpty ? .pass : .fail, (failed.isEmpty ? "" : "failed: \(failed) ") + report)
    }
  }
}

@MainActor private func e2eSelfTest(
  web: WKWebView, bridge: NativeGPUBridge, composition: NativeGPUSurfaceHost?,
  onNextLoad: @escaping (@escaping () -> Void) -> Void,
  finish: @escaping (NativeGPUSelfTestStatus, String) -> Void
) {
  // Real app path: engine/page.html, demo reactor in the engine Worker, native wire, executor C API.
  let script = """
    for (let i = 0; !window.engineDemo && i < 400; i++) await new Promise((r) => setTimeout(r, 25));
    const demo = window.engineDemo;
    if (!demo) throw new Error('engine page did not start: ' + document.getElementById('report')?.textContent);
    if (!demo.nativeGpu) throw new Error('native GPU was not selected by the page');
    const first = (prefixes, ms) => Promise.race(prefixes.map((p) => demo.waitReport(p, ms))).catch((e) => 'TIMEOUT ' + e.message);
    const outcome = await first(['GPU_READBACK_OK', 'GPU_READBACK_FAILED', 'ENGINE_FAILED', 'ENGINE_ERROR', 'GPU_UNAVAILABLE'], 60000);
    let restart = null;
    if (outcome.startsWith('GPU_READBACK_OK') && restartCheck) {
      // A new engine generation: the native side retires generation 1 (executor destroyed, layer lease released)
      // and generation 2 must execute and read back again.
      const count = () => demo.reports.filter((line) => line.startsWith('GPU_READBACK_OK')).length;
      const before = count();
      const result = await demo.lane.restart({ reason: 'native GPU self-test' });
      const deadline = performance.now() + 60000;
      while (count() === before && performance.now() < deadline && demo.lane.state === 'ready') await demo.waitReport('GPU_', 1000).catch(() => {}).then(() => new Promise((r) => setTimeout(r, 50)));
      restart = { ok: result.ok, generation: result.generation, readbacks: count() - before, state: demo.lane.state };
    }
    return { outcome, restart, mode: demo.lane.mode, state: demo.lane.state, reports: demo.reports.slice(-60) };
    """
  web.callAsyncJavaScript(script, arguments: ["restartCheck": true], in: nil, in: .page) { result in
    let native = bridge.stats.snapshot()
    switch result {
    case .failure(let error):
      finish(.fail, "e2e: \(error.localizedDescription) native=\(json(native))")
    case .success(let value):
      let object = value as? [String: Any] ?? [:]
      let outcome = object["outcome"] as? String ?? ""
      let crossed = (native["bodies"] ?? 0) > 0 && (native["engines"] ?? 0) > 0
      let summary = json(["outcome": outcome, "page": object, "native": native, "linkage": NativeGPUExecutorAPI.linkage] as [String: Any])
      if NativeGPUExecutorAPI.linkage == "unlinked" {
        // The Worker's upstream frames crossed and executor creation was attempted; nothing executed.
        finish(crossed ? .pendingExecutor : .fail, (crossed ? "crossing reached the executor C API; " : "no crossing; ") + summary)
        return
      }
      let executed =
        outcome.hasPrefix("GPU_READBACK_OK") && (native["submissions"] ?? 0) >= 2 && native["submissions"] == native["acks"]
        && (native["uploadBytes"] ?? 0) >= Double(16 * 1_048_576) && (native["readbacks"] ?? 0) >= 1
      let restart = object["restart"] as? [String: Any]
      let restarted =
        ((restart?["ok"] as? Bool) == true && ((restart?["readbacks"] as? Int) ?? 0) >= 1
          && native["executorsCreated"] == 2 && (native["executorsDestroyed"] ?? 0) >= 1)
      guard executed, restarted else {
        // Display ticks pause while the window is occluded (as rAF does in a browser): say so explicitly.
        let visible = web.window.map { $0.occlusionState.contains(.visible) } ?? false
        finish(.fail, "e2e (window visible=\(visible), presentation=\(composition?.windowVisible ?? false)): " + summary); return
      }
      guard let composition else {
        reloadPhase(web: web, bridge: bridge, script: script, onNextLoad: onNextLoad) { ok, detail in
          finish(ok ? .pass : .fail, "e2e: reload=\(detail) " + summary)
        }
        return
      }
      measureComposition(web: web, bridge: bridge, surface: composition) { ok, measured in
        finish(ok ? .pass : .fail, "e2e+composition: \(measured) " + summary)
      }
    }
  }
}

/// Reload: navigation must end the old page's capability and engine generations (executors destroyed) and the new
/// page must claim a fresh session and execute again.
@MainActor private func reloadPhase(
  web: WKWebView, bridge: NativeGPUBridge, script: String, onNextLoad: @escaping (@escaping () -> Void) -> Void,
  done: @escaping (Bool, String) -> Void
) {
  let before = bridge.stats.snapshot()
  onNextLoad {
    web.callAsyncJavaScript(script, arguments: ["restartCheck": false], in: nil, in: .page) { result in
      let after = bridge.stats.snapshot()
      let outcome = ((try? result.get()) as? [String: Any])?["outcome"] as? String ?? "\(result)"
      let created = (after["executorsCreated"] ?? 0) - (before["executorsCreated"] ?? 0)
      let destroyed = (after["executorsDestroyed"] ?? 0) - (before["executorsDestroyed"] ?? 0)
      let ok = outcome.hasPrefix("GPU_READBACK_OK") && created == 1 && destroyed >= 1
      done(ok, json(["outcome": outcome, "executorsCreated": created, "executorsDestroyed": destroyed] as [String: Any]))
    }
  }
  web.reload()
}

/// Own-window capture (CoreGraphics; capturing this app's own window needs no Screen Recording permission on
/// the tested system). Looked up dynamically because the SDK marks it obsolete.
@MainActor func captureOwnWindow(_ window: NSWindow) -> NSBitmapImageRep? {
  typealias Capture = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
  let capture = unsafeBitCast(symbol, to: Capture.self)
  guard let image = capture(.null, 1 << 3, UInt32(window.windowNumber), 1 | (1 << 3))?.takeRetainedValue() else { return nil }
  return NSBitmapImageRep(cgImage: image)
}

/// Composited-pixel measurement: a rounded, translucent red DOM box over the native scene, plus calibration boxes
/// (opaque red and the same translucent red) over the page outside the canvas. Values are raw capture components
/// (no colour conversion); the blend model is checked on the calibration box before it is applied to the scene.
/// Underlay must blend DOM over the scene; overlay shows the scene over unreported DOM (documented limitation).
@MainActor private func measureComposition(
  web: WKWebView, bridge: NativeGPUBridge, surface: NativeGPUSurfaceHost, done: @escaping (Bool, String) -> Void
) {
  let script = """
    const canvas = document.getElementById('surface'); const r = canvas.getBoundingClientRect();
    const add = (x, y, colour) => { const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:120px;height:80px;background:${colour};border-radius:16px;pointer-events:none`;
      document.body.appendChild(box); return [x, y, 120, 80]; };
    const over = add(r.x + 20, r.y + 20, 'rgba(255,0,0,0.5)');
    const solid = add(r.right + 20, r.y + 20, 'rgb(255,0,0)');
    const half = add(r.right + 20, r.y + 140, 'rgba(255,0,0,0.5)');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const now = canvas.getBoundingClientRect();
    return { canvas: [now.x, now.y, now.width, now.height], over, solid, half };
    """
  web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
    guard case .success(let value) = result, let object = value as? [String: Any],
      let canvas = object["canvas"] as? [Double], let over = object["over"] as? [Double],
      let solid = object["solid"] as? [Double], let half = object["half"] as? [Double], let window = web.window,
      let image = captureOwnWindow(window)
    else { done(false, "composition: capture unavailable"); return }
    if let path = ProcessInfo.processInfo.environment["NT_NATIVE_GPU_CAPTURE_PNG"], let png = image.representation(using: .png, properties: [:]) {
      try? png.write(to: URL(fileURLWithPath: path))
    }
    let surfaceFrame = surface.view.map { web.convert($0.frame, from: $0.superview) } ?? .zero
    let scale = Double(image.pixelsWide) / Double(window.frame.width)
    let top = Double(image.pixelsHigh) - Double(web.bounds.height) * scale
    func sample(_ x: Double, _ y: Double) -> [Double] {
      guard let c = image.colorAt(x: Int(x * scale), y: Int(top + y * scale)), c.numberOfComponents >= 3 else { return [] }
      return [c.redComponent, c.greenComponent, c.blueComponent].map { (Double($0) * 1000).rounded() / 1000 }
    }
    let centre = { (box: [Double]) in sample(box[0] + box[2] / 2, box[1] + box[3] / 2) }
    let mix = { (a: [Double], b: [Double]) -> [Double] in a.count == 3 && b.count == 3 ? zip(a, b).map { 0.5 * $0 + 0.5 * $1 } : [] }
    let near = { (a: [Double], b: [Double]) in a.count == 3 && b.count == 3 && zip(a, b).allSatisfy { abs($0 - $1) < 0.06 } }
    let scene = sample(canvas[0] + canvas[2] - 12, canvas[1] + canvas[3] - 12)
    let red = centre(solid)
    let pageUnderHalf = sample(half[0] - 8, half[1] + half[3] / 2)
    let halfMeasured = centre(half), domOverScene = centre(over)
    let calibrated = near(halfMeasured, mix(red, pageUnderHalf))
    let underlay = surface.composition != .overlay
    let aligned = abs(surfaceFrame.minX - canvas[0]) < 1.5 && abs(surfaceFrame.minY - canvas[1]) < 1.5
      && abs(surfaceFrame.width - canvas[2]) < 1.5 && abs(surfaceFrame.height - canvas[3]) < 1.5
    let ok = aligned && calibrated && (underlay ? near(domOverScene, mix(red, scene)) : near(domOverScene, scene))
    done(
      ok,
      json([
        "composition": underlay ? "underlay (private SPI)" : "overlay (public)",
        "surfaceAlignedToCanvas": aligned, "canvasCss": canvas,
        "surfaceFrameInWebView": [surfaceFrame.minX, surfaceFrame.minY, surfaceFrame.width, surfaceFrame.height],
        "rawSamples": ["scene": scene, "opaqueRedDom": red, "halfRedOverPage": halfMeasured, "pageUnderHalf": pageUnderHalf, "halfRedOverScene": domOverScene],
        "blendModelCalibrated": calibrated, "expectedUnderlayBlend": mix(red, scene),
        "interpretation": underlay
          ? (ok ? "translucent rounded DOM blends over the native scene" : "DOM did not blend over the scene as modelled")
          : (ok ? "native scene covers unreported DOM (documented overlay limitation; no DOM/scene blending)" : "unexpected overlay pixels"),
      ] as [String: Any]))
  }
}
