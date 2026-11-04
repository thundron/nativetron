#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-sim}"
case "$MODE" in sim|device) ;; *) echo 'usage: build.sh sim|device' >&2; exit 1;; esac
if [[ "$MODE" == device ]]; then
  : "${NT_IOS_TEAM:?set NT_IOS_TEAM to your own Apple developer team}"
  [[ "$NT_IOS_TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo 'invalid Apple developer team id' >&2; exit 1; }
  case "$NT_IOS_TEAM" in UQBV6LD494|DM6V8H4Q6Q) echo 'GEWISS signing teams are prohibited' >&2; exit 1;; esac
fi
cd "$ROOT"
engine/build.sh --web
node ipc/generate-engine.mjs --check
mkdir -p build/ios-project

xcodegen generate --spec hosts/ios/project.yml --project build/ios-project --quiet
if [[ "$MODE" == sim ]]; then
  SIM="${NT_IOS_SIMULATOR:-$(xcrun simctl list devices -j | python3 -c 'import json,sys; d=[x for k,v in json.load(sys.stdin)["devices"].items() if "iOS-18-6" in k for x in v if x["isAvailable"]]; print(d[0]["udid"] if d else "")')}"
  [[ -n "$SIM" ]] || { echo 'iOS 18.6 simulator required; do not use the iOS 26 simulator on macOS 27' >&2; exit 1; }
  RUNTIME="$(xcrun simctl list devices -j | python3 -c 'import json,sys; print(next((k for k,v in json.load(sys.stdin)["devices"].items() if any(x["udid"]==sys.argv[1] for x in v)), ""))' "$SIM")"
  if [[ "$(sw_vers -productVersion)" == 27.* && "$RUNTIME" == *iOS-26* ]]; then echo 'iOS 26 simulator WebContent JIT PAC crash on macOS 27: use iOS 18.6 or a physical device' >&2; exit 1; fi
  xcrun simctl boot "$SIM" 2>/dev/null || true
  xcodebuild -project build/ios-project/Nativetron.xcodeproj -scheme Nativetron -configuration Debug -destination "id=$SIM" -derivedDataPath build/ios CODE_SIGNING_ALLOWED=NO -quiet
  xcrun simctl install "$SIM" build/ios/Build/Products/Debug-iphonesimulator/Nativetron.app
  xcrun simctl launch "$SIM" dev.nativetron.gpu
else
  : "${NT_IOS_DEVICE:?set NT_IOS_DEVICE to the physical device identifier}"
  xcodebuild -project build/ios-project/Nativetron.xcodeproj -scheme Nativetron -configuration Debug -destination "id=$NT_IOS_DEVICE" -derivedDataPath build/ios DEVELOPMENT_TEAM="$NT_IOS_TEAM" -allowProvisioningUpdates -quiet
  xcrun devicectl device install app --device "$NT_IOS_DEVICE" build/ios/Build/Products/Debug-iphoneos/Nativetron.app
  xcrun devicectl device process launch --device "$NT_IOS_DEVICE" dev.nativetron.gpu
fi
