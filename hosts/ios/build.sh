#!/usr/bin/env bash
# iOS host build. Modes:
#   sim-build       build only, iOS Simulator (arm64), unsigned, isolated derived data
#   device-compile  build only, iphoneos, unsigned compile/link check (not installable)
#   device-build    signed device build; requires NT_IOS_TEAM (your own team)
#   sim | device    build, install and launch (runtime; prefer hosts/ios/accept.sh for evidence)
# NT_IOS_SKIP_ENGINE=1 reuses an existing build/engine-assets bundle.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MODE="${1:-sim}"
case "$MODE" in sim|device|sim-build|device-build|device-compile) ;; *) echo 'usage: build.sh sim|device|sim-build|device-build|device-compile' >&2; exit 1;; esac
# Signing policy runs before any build, project generation or toolchain action.
source "$HERE/signing-policy.sh"
nt_ios_check_team "$MODE"
cd "$ROOT"
case "$MODE" in sim|sim-build) SDK=iphonesimulator ;; *) SDK=iphoneos ;; esac

if [[ "${NT_IOS_SKIP_ENGINE:-0}" != 1 ]]; then engine/build.sh --web; fi
[[ -f build/engine-assets/engine/page.html ]] || { echo 'ios: build/engine-assets is missing; run engine/build.sh --web' >&2; exit 1; }
node ipc/generate-engine.mjs --check
node ipc/generate-control.mjs --check
"$HERE/build-control.sh" "$SDK"
mkdir -p build/ios-project
xcodegen generate --spec hosts/ios/project.yml --project build/ios-project --quiet
PROJECT=build/ios-project/Nativetron.xcodeproj
DERIVED="build/ios-$SDK"
APP="$DERIVED/Build/Products/Debug-$SDK/Nativetron.app"

case "$MODE" in
  sim-build)
    xcodebuild -project "$PROJECT" -scheme Nativetron -configuration Debug -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO NT_IOS_TEAM= DEVELOPMENT_TEAM= -quiet build
    echo "ios: built $APP" ;;
  device-compile)
    xcodebuild -project "$PROJECT" -scheme Nativetron -configuration Debug -destination 'generic/platform=iOS' \
      -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO NT_IOS_TEAM= DEVELOPMENT_TEAM= -quiet build
    echo "ios: compiled unsigned $APP (not installable)" ;;
  device-build|device)
    DEST='generic/platform=iOS'
    if [[ "$MODE" == device ]]; then : "${NT_IOS_DEVICE:?set NT_IOS_DEVICE to the physical device identifier}"; DEST="id=$NT_IOS_DEVICE"; fi
    xcodebuild -project "$PROJECT" -scheme Nativetron -configuration Debug -destination "$DEST" -derivedDataPath "$DERIVED" \
      NT_IOS_TEAM="$NT_IOS_TEAM" DEVELOPMENT_TEAM="$NT_IOS_TEAM" -allowProvisioningUpdates -quiet build
    nt_ios_verify_signature "$APP"
    if [[ "$MODE" == device ]]; then
      xcrun devicectl device install app --device "$NT_IOS_DEVICE" "$APP"
      xcrun devicectl device process launch --device "$NT_IOS_DEVICE" dev.nativetron.gpu
    fi ;;
  sim)
    SIM="$("$HERE/select-simulator.sh")"
    xcodebuild -project "$PROJECT" -scheme Nativetron -configuration Debug -destination "id=$SIM" \
      -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO NT_IOS_TEAM= DEVELOPMENT_TEAM= -quiet build
    xcrun simctl boot "$SIM" 2>/dev/null || true
    xcrun simctl install "$SIM" "$APP"
    xcrun simctl launch "$SIM" dev.nativetron.gpu ;;
esac
