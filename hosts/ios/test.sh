#!/usr/bin/env bash
# Focused iOS host checks that need no simulator or device:
#  1. script/signing/simulator-selection/evidence policy tests (node --test hosts/ios/verify.mjs)
#  2. Swift typecheck of the app sources for iphonesimulator and iphoneos
#  3. host conformance harness: the app's ControlLibrary/AssetCatalog sources linked with the
#     real scriptc control archive built for macOS from ipc/control-profile.json
# NT_IOS_TEST_CONTROL_ARCHIVE may name an already-built macOS archive of the same profile; its
# digest is printed so the provenance is explicit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/build/ios-test"
mkdir -p "$OUT"
for script in build.sh build-control.sh accept.sh select-simulator.sh signing-policy.sh test.sh; do bash -n "$HERE/$script"; done
python3 -c "import ast, sys; ast.parse(open(sys.argv[1]).read())" "$HERE/summarize-evidence.py"
node --test "$HERE/verify.mjs"

SOURCES=("$HERE"/Sources/*.swift)
for sdk in iphonesimulator iphoneos; do
  target=arm64-apple-ios18.6; [[ "$sdk" == iphonesimulator ]] && target+=-simulator
  xcrun swiftc -typecheck -sdk "$(xcrun --sdk $sdk --show-sdk-path)" -target "$target" -swift-version 5 \
    -import-objc-header "$HERE/Sources/NativetronControl-Bridging.h" -I "$ROOT/ipc" "${SOURCES[@]}"
  echo "ios test: typecheck $sdk ok"
done

if [[ -n "${NT_IOS_TEST_CONTROL_ARCHIVE:-}" ]]; then
  ARCHIVE="$NT_IOS_TEST_CONTROL_ARCHIVE"
  echo "ios test: using supplied control archive $ARCHIVE sha256 $(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
else
  rm -f "$ROOT/ipc/.scriptc/control.lib.a"
  env -u SCRIPTC_TARGET "$ROOT/ipc/build-control.sh"
  ARCHIVE="$OUT/libntcontrol-macos.a"
  cp "$ROOT/ipc/.scriptc/control.lib.a" "$ARCHIVE"
fi
HARNESS_SOURCES=("$HERE/tests/main.swift" "$HERE/Sources/ControlLibrary.swift" "$HERE/Sources/AssetCatalog.swift" \
  "$HERE/Sources/BundledAssets.generated.swift" "$HERE/Sources/AssetProbe.swift" "$HERE/Sources/Evidence.swift" "$HERE/Sources/EngineProtocol.generated.swift")
xcrun swiftc -O -target arm64-apple-macos14 -swift-version 5 -import-objc-header "$HERE/Sources/NativetronControl-Bridging.h" \
  -I "$ROOT/ipc" "${HARNESS_SOURCES[@]}" "$ARCHIVE" -o "$OUT/ios-host-harness"
STATUS=0
"$OUT/ios-host-harness" >"$OUT/harness.log" 2>&1 || STATUS=$?
grep -E '^(FAIL|ios host harness)' "$OUT/harness.log" || tail -20 "$OUT/harness.log"
exit "$STATUS"
