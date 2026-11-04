#!/usr/bin/env bash
# Print the UDID of the simulator to use. Read-only: lists devices, never boots or creates.
# NT_IOS_SIMULATOR selects explicitly; otherwise the first available iOS 18.6 simulator.
# iOS 26 simulators are refused on macOS 27 (WebContent JIT PAC crash).
# NT_IOS_SIMCTL_JSON / NT_IOS_MACOS_VERSION substitute inputs for tests.
set -euo pipefail
if [[ -n "${NT_IOS_SIMCTL_JSON:-}" ]]; then LIST="$(cat "$NT_IOS_SIMCTL_JSON")"; else LIST="$(xcrun simctl list devices -j)"; fi
MACOS="${NT_IOS_MACOS_VERSION:-$(sw_vers -productVersion)}"
python3 -c '
import json, sys
devices = json.loads(sys.argv[1])["devices"]
wanted, macos = sys.argv[2], sys.argv[3]
def runtime_of(udid):
    return next((k for k, v in devices.items() if any(x["udid"] == udid for x in v)), "")
if wanted:
    runtime = runtime_of(wanted)
    if not runtime: sys.exit("ios: simulator %s not found" % wanted)
    udid = wanted
else:
    found = [(k, x["udid"]) for k, v in devices.items() if k.endswith("iOS-18-6") for x in v if x.get("isAvailable")]
    if not found: sys.exit("ios: iOS 18.6 simulator required; do not use the iOS 26 simulator on macOS 27")
    runtime, udid = found[0]
if macos.startswith("27.") and "iOS-26" in runtime:
    sys.exit("ios: iOS 26 simulator WebContent JIT PAC crash on macOS 27: use iOS 18.6 or a physical device")
print(udid)
' "$LIST" "${NT_IOS_SIMULATOR:-}" "$MACOS"
