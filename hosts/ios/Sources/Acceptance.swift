import Foundation
import UIKit

/// In-app acceptance sequence, enabled only by the `--nt-acceptance` launch argument.
///
/// Cycle 1 waits for the page's engine reports, sends the native change-colour command through
/// the scriptc control library, probes the offline asset policy from inside WebKit, then
/// disposes the host and proves it was released. Cycle 2 repeats the engine/command path on a
/// fresh WKWebView. The final line is `NT_IOS_ACCEPT_DONE status=<pass|gpu-unavailable|fail>`.
/// GPU rendering is only reported as passing when the engine itself reports GPU_COLOUR_CHANGED.
@MainActor final class Acceptance: HostObserver {
  static let enabled = ProcessInfo.processInfo.arguments.contains("--nt-acceptance")
  static let shared = Acceptance()
  static let timeout: TimeInterval = 60
  static let commandFallbackDelay: TimeInterval = 8

  private weak var scene: SceneDelegate?
  private var cycle = 0
  private var commandSent = false, delivered = false, colourChanged = false, gpuUnavailable = false, cycleDone = false
  private var finished = false
  private var results: [String: String] = [:]
  private var failures: [String] = []

  func begin(scene: SceneDelegate) {
    guard !finished, cycle == 0 else { return }
    self.scene = scene
    cycle = 1
    Evidence.emit("NT_IOS_ACCEPT_BEGIN", "timeout=\(Int(Self.timeout))s control=\(ControlLibrary.shared.started)")
    if !ControlLibrary.shared.started { failures.append("control-library-start") }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout) { [weak self] in
      guard let self, !self.finished else { return }
      self.failures.append("timeout-cycle-\(self.cycle)")
      self.finish()
    }
  }

  func hostDidLoadPage(_ host: HostController) {
    results["cycle\(cycle).page"] = "loaded"
  }

  func host(_ host: HostController, report: String) {
    guard !finished, host === scene?.host else { return }
    if report.hasPrefix("ENGINE_MODE ") {
      results["cycle\(cycle).mode"] = String(report.dropFirst(12))
      let current = cycle
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.commandFallbackDelay) { [weak self, weak host] in
        guard let self, let host, self.cycle == current else { return }
        self.sendCommand(host, reason: "fallback-after-engine-mode")
      }
    } else if report == "GPU_READBACK_OK 4096" {
      results["cycle\(cycle).readback"] = "ok"
      sendCommand(host, reason: "readback")
    } else if report.hasPrefix("GPU_UNAVAILABLE") || report.hasPrefix("GPU_ERROR") {
      gpuUnavailable = true
      results["cycle\(cycle).gpu"] = report
      sendCommand(host, reason: "gpu-unavailable")
    } else if report == "GPU_COLOUR_CHANGED" {
      colourChanged = true
      results["cycle\(cycle).colour"] = "changed"
      completeCycle(host)
    }
  }

  func host(_ host: HostController, delivered ok: Bool) {
    guard !finished, host === scene?.host, commandSent else { return }
    delivered = ok
    results["cycle\(cycle).command"] = ok ? "delivered" : "failed"
    if !ok { failures.append("command-delivery-cycle-\(cycle)") }
    // Without a GPU the engine cannot acknowledge the colour change; the control path is
    // still verified end to end (library encode → page receiver accepted the frame).
    if gpuUnavailable || !ok {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak host] in
        guard let self, let host else { return }
        self.completeCycle(host)
      }
    }
  }

  private func sendCommand(_ host: HostController, reason: String) {
    guard !commandSent, !finished else { return }
    commandSent = true
    let status = host.sendCommand(topic: HostController.changeColourTopic)
    results["cycle\(cycle).commandStatus"] = status.rawValue
    Evidence.emit("NT_IOS_ACCEPT_COMMAND", "cycle=\(cycle) reason=\(reason) status=\(status.rawValue)")
    if status != .accepted { failures.append("command-\(status.rawValue)-cycle-\(cycle)"); completeCycle(host) }
  }

  private func completeCycle(_ host: HostController) {
    guard !cycleDone, !finished else { return }
    cycleDone = true
    if cycle == 1 {
      probeAssets(host) { [weak self] in self?.remount() }
    } else {
      finish()
    }
  }

  private func probeAssets(_ host: HostController, then next: @escaping @MainActor () -> Void) {
    host.evaluate(AssetProbe.script) { [weak self] text in
      guard let self else { return }
      Evidence.emit("NT_IOS_ASSET_PROBE", text ?? "<no result>")
      let verdict = AssetProbe.judge(text)
      self.results["assets"] = verdict.isEmpty ? "ok" : verdict.joined(separator: ",")
      self.failures.append(contentsOf: verdict.map { "asset-\($0)" })
      next()
    }
  }

  private func remount() {
    guard let scene, !finished else { return }
    let old = scene.remount()
    cycle = 2
    commandSent = false; delivered = false; colourChanged = false; gpuUnavailable = false; cycleDone = false
    checkReleased(old, attempt: 0)
  }

  private func checkReleased(_ old: WeakBox<HostController>, attempt: Int) {
    if old.value == nil {
      results["dispose"] = "released"
      Evidence.emit("NT_IOS_DISPOSE_CHECK", "released=true attempts=\(attempt)")
    } else if attempt < 20 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.checkReleased(old, attempt: attempt + 1) }
    } else {
      results["dispose"] = "retained"
      failures.append("host-retained-after-dispose")
      Evidence.emit("NT_IOS_DISPOSE_CHECK", "released=false")
    }
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    let counters = ControlLibrary.shared.counters
    results["control"] = "commands=\(counters.commands) received=\(counters.received) refused=\(counters.refused) captured=\(counters.captured) dropped=\(counters.dropped) collections=\(counters.collections)"
    let colour = (1...2).allSatisfy { results["cycle\($0).colour"] == "changed" }
    let commands = (1...2).allSatisfy { results["cycle\($0).command"] == "delivered" }
    let status = !failures.isEmpty || !commands || results["dispose"] != "released" ? "fail" : colour ? "pass" : "gpu-unavailable"
    let summary = (try? JSONSerialization.data(withJSONObject: ["status": status, "results": results, "failures": failures], options: [.sortedKeys]))
      .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    Evidence.emit("NT_IOS_ACCEPT_SUMMARY", summary)
    Evidence.emit("NT_IOS_ACCEPT_DONE", "status=\(status)")
  }
}
