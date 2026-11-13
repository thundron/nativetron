// nt-bench-probe: power state and per-process counters for the native GPU benchmark (read-only; changes nothing).
//
//   nt-bench-probe power          one JSON line: ProcessInfo.isLowPowerModeEnabled, thermalState, providing power
//                                 source (IOPS), battery percent/charging. NOT Metal's MTLDevice.isLowPower (a GPU
//                                 class property, unrelated to the OS Low Power Mode).
//   nt-bench-probe serve          reads lines "<pid>,<pid>,…" on stdin; answers each with one JSON line:
//                                 { t_ns, procs: { pid: { cpu_ns, phys_footprint, wakeups, pkg_idle_wkups,
//                                   instructions, cycles, gpu_ns, name } }, gpu_all: { pid: gpu_ns } }
//                                 cpu_ns = user + system (proc_pid_rusage V4, same-user processes);
//                                 gpu_ns = sum of AppUsage.accumulatedGPUTime of the pid's AGXDeviceUserClient(s)
//                                 (IORegistry, the kernel's per-client GPU time, all GPU work of that process);
//                                 gpu_all = every Metal client process (for contention checks), gpu_names = their
//                                 process names (clients with GPU time).
// Build: swiftc -O -o <out>/nt-bench-probe gpu/native/benchmark/probe.swift -framework IOKit
import Darwin
import Foundation
import IOKit
import IOKit.ps

func json(_ object: Any) -> String {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  return String(decoding: data, as: UTF8.self)
}

func power() -> [String: Any] {
  let info = ProcessInfo.processInfo
  let thermal: String
  switch info.thermalState {
  case .nominal: thermal = "nominal"
  case .fair: thermal = "fair"
  case .serious: thermal = "serious"
  case .critical: thermal = "critical"
  @unknown default: thermal = "unknown(\(info.thermalState.rawValue))"
  }
  var out: [String: Any] = [
    "isLowPowerModeEnabled": info.isLowPowerModeEnabled, "thermalState": thermal,
    "thermalStateRaw": info.thermalState.rawValue, "uptimeS": info.systemUptime,
    "activeProcessorCount": info.activeProcessorCount, "os": info.operatingSystemVersionString,
  ]
  if let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() {
    out["providingPowerSource"] = IOPSGetProvidingPowerSourceType(blob)?.takeUnretainedValue() as String? ?? "unknown"
    if let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] {
      out["sources"] = list.compactMap { source -> [String: Any]? in
        guard let d = IOPSGetPowerSourceDescription(blob, source)?.takeUnretainedValue() as? [String: Any] else { return nil }
        var keep: [String: Any] = [:]
        for key in ["Name", "Type", "Power Source State", "Current Capacity", "Max Capacity", "Is Charging", "Is Charged"] {
          if let v = d[key] { keep[key] = v }
        }
        return keep
      }
    }
  }
  return out
}

/// pid → accumulated GPU ns over every AGXDeviceUserClient the process created.
func gpuTimes() -> [Int32: UInt64] {
  var result: [Int32: UInt64] = [:]
  var iterator: io_iterator_t = 0
  // user clients are not matchable services: walk the service plane (as `ioreg -r -c AGXDeviceUserClient`)
  guard IORegistryCreateIterator(kIOMainPortDefault, kIOServicePlane, IOOptionBits(kIORegistryIterateRecursively), &iterator)
    == KERN_SUCCESS
  else { return result }
  defer { IOObjectRelease(iterator) }
  while case let service = IOIteratorNext(iterator), service != 0 {
    defer { IOObjectRelease(service) }
    guard IOObjectConformsTo(service, "AGXDeviceUserClient") != 0,
      let creator = IORegistryEntryCreateCFProperty(service, "IOUserClientCreator" as CFString, kCFAllocatorDefault, 0)?
      .takeRetainedValue() as? String,
      creator.hasPrefix("pid "),
      let pid = Int32(creator.dropFirst(4).prefix { $0.isNumber })
    else { continue }
    var total: UInt64 = result[pid] ?? 0
    if let usage = IORegistryEntryCreateCFProperty(service, "AppUsage" as CFString, kCFAllocatorDefault, 0)?
      .takeRetainedValue() as? [[String: Any]]
    {
      for entry in usage { total += (entry["accumulatedGPUTime"] as? NSNumber)?.uint64Value ?? 0 }
    }
    result[pid] = total
  }
  return result
}

func name(_ pid: Int32) -> String {
  var buffer = [CChar](repeating: 0, count: 4 * Int(MAXCOMLEN) + 1)
  let n = proc_name(pid, &buffer, UInt32(buffer.count))
  return n > 0 ? String(cString: buffer) : ""
}

func usage(_ pid: Int32) -> [String: Any]? {
  var info = rusage_info_v4()
  let rc = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
  }
  guard rc == 0 else { return nil }
  // ri_user_time / ri_system_time are mach absolute time units
  var timebase = mach_timebase_info_data_t()
  mach_timebase_info(&timebase)
  let ticks = info.ri_user_time + info.ri_system_time
  let ns = ticks * UInt64(timebase.numer) / UInt64(timebase.denom)
  return [
    "cpu_ns": ns, "phys_footprint": info.ri_phys_footprint, "resident": info.ri_resident_size,
    "wakeups": info.ri_interrupt_wkups, "pkg_idle_wkups": info.ri_pkg_idle_wkups,
    "instructions": info.ri_instructions, "cycles": info.ri_cycles, "name": name(pid),
  ]
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "power":
  print(json(power()))
case "serve":
  setvbuf(stdout, nil, _IOLBF, 0)
  while let line = readLine() {
    let pids = line.split(separator: ",").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
    let gpu = gpuTimes()
    var procs: [String: Any] = [:]
    for pid in pids {
      guard var u = usage(pid) else { procs[String(pid)] = ["gone": true]; continue }
      u["gpu_ns"] = gpu[pid] ?? 0
      procs[String(pid)] = u
    }
    var all: [String: Any] = [:], names: [String: Any] = [:]
    for (pid, ns) in gpu { all[String(pid)] = ns; if ns > 0 { names[String(pid)] = name(pid) } }
    print(json(["t_ns": clock_gettime_nsec_np(CLOCK_UPTIME_RAW), "procs": procs, "gpu_all": all, "gpu_names": names]))
  }
default:
  FileHandle.standardError.write("usage: nt-bench-probe power | serve\n".data(using: .utf8)!)
  exit(2)
}
