#!/usr/bin/env bash
# Apply the WebContent workaround only to the affected simulator/runtime pair.
# First argument is UDID, followed by simctl launch flags and bundle/arguments.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SIM="${1:?usage: launch-simulator.sh UDID [launch-flags] BUNDLE [args]}"; shift
if [[ -n "${NT_IOS_SIMCTL_JSON:-}" ]]; then LIST="$(cat "$NT_IOS_SIMCTL_JSON")"; else LIST="$(xcrun simctl list devices -j)"; fi
MACOS="${NT_IOS_MACOS_VERSION:-$(sw_vers -productVersion)}"
NEEDS_FLAG="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1])["devices"]; r=next((k for k,v in d.items() if any(x["udid"]==sys.argv[2] for x in v)), ""); print("yes" if sys.argv[3].startswith("27.") and "iOS-26" in r else "no")' "$LIST" "$SIM" "$MACOS")"
FLAGS=()
while [[ "${1:-}" == --* ]]; do FLAGS+=("$1"); shift; done
if [[ "$NEEDS_FLAG" == yes ]]; then
  echo 'ios: compatibility mode: WebContent JIT disabled (iOS 26 simulator on macOS 27); not a performance baseline' >&2
  export __XPC_JSC_useJIT=false
  export SIMCTL_CHILD___XPC_JSC_useJIT=false
fi
exec xcrun simctl launch "${FLAGS[@]}" "$SIM" "$@"
