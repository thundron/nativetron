#!/usr/bin/env bash
# Print the UDID of the simulator to use. Read-only: lists devices, never boots or creates.
# NT_IOS_SIMULATOR selects explicitly; otherwise prefer iOS 18.6, then another available iOS runtime.
# The launch helper applies the iOS 26/macOS 27 JIT compatibility setting.
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
    if not found: found = [(k, x["udid"]) for k, v in devices.items() if "iOS-" in k for x in v if x.get("isAvailable")]
    if not found: sys.exit("ios: no available iOS simulator")
    runtime, udid = found[0]
if not any(x["udid"] == udid and x.get("isAvailable", True) for x in devices[runtime]):
    sys.exit("ios: selected simulator is unavailable")
print(udid)
' "$LIST" "${NT_IOS_SIMULATOR:-}" "$MACOS"
