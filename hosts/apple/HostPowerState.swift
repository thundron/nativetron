import Foundation

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

// OS facts only. The application decides whether to lower frame/sample budgets.
final class HostPowerState {
  typealias Facts = (lowPower: Bool, thermal: Int)
  private let read: () -> Facts
  private let notify: ([String: Any]) -> Void
  private var observers: [NSObjectProtocol] = []
  private var revision = 0
  private var last: Facts?
  private var closed = false
  init(
    read: @escaping () -> Facts = {
      (ProcessInfo.processInfo.isLowPowerModeEnabled, ProcessInfo.processInfo.thermalState.rawValue)
    }, observe: Bool = true, notify: @escaping ([String: Any]) -> Void
  ) {
    self.read = read
    self.notify = notify
    if observe {
      var names: [Notification.Name] = [
        .NSProcessInfoPowerStateDidChange, ProcessInfo.thermalStateDidChangeNotification,
      ]
      #if os(iOS)
        names.append(UIApplication.didBecomeActiveNotification)
      #else
        names.append(NSApplication.didBecomeActiveNotification)
      #endif
      for name in names {
        observers.append(
          NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
            [weak self] _ in self?.refresh()
          })
      }
    }
  }
  func snapshot() -> [String: Any] {
    let facts = read()
    if last == nil || last!.lowPower != facts.lowPower || last!.thermal != facts.thermal {
      revision += 1
      last = facts
    }
    #if os(iOS)
      let platform = "ios"
    #else
      let platform = "macos"
    #endif
    let names = [0: "nominal", 1: "fair", 2: "serious", 3: "critical"]
    return [
      "platform": platform, "lowPowerMode": facts.lowPower,
      "thermalState": names[facts.thermal] ?? "unknown", "nativeThermalState": facts.thermal,
      "revision": revision,
    ]
  }
  func refresh() {
    guard !closed else { return }
    notify(snapshot())
  }
  func dispose() {
    guard !closed else { return }
    closed = true
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
  }
  deinit { dispose() }
}
