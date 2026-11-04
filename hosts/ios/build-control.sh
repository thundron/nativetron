#!/usr/bin/env bash
# Build the real scriptc static control library (ipc/control-profile.json) for one iOS SDK and
# stage it as build/ios-control/<sdk>/libntcontrol.a with a provenance record.
#   hosts/ios/build-control.sh iphonesimulator|iphoneos
# SCRIPTC selects the compiler entry point (default: ../../scriptc/packages/cli/dist/main.js).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK="${1:-}"
case "$SDK" in
  iphonesimulator) TARGET=aarch64-apple-ios-simulator; PLATFORM=7; PACK=runtime-ios-simulator-arm64 ;;
  iphoneos) TARGET=aarch64-apple-ios; PLATFORM=2; PACK=runtime-ios-arm64 ;;
  *) echo 'usage: build-control.sh iphonesimulator|iphoneos' >&2; exit 2 ;;
esac
OUT="$ROOT/build/ios-control/$SDK"
ARCHIVE="$ROOT/ipc/.scriptc/control.lib.a"
LOG="$(mktemp -t nt-ios-control)"
trap 'rm -f "$LOG"' EXIT
rm -f "$ARCHIVE"
if ! SCRIPTC_TARGET="$TARGET" "$ROOT/ipc/build-control.sh" >"$LOG" 2>&1; then
  cat "$LOG" >&2
  if grep -q "runtime-pack.json" "$LOG"; then
    echo "ios control: the @scriptc/$PACK runtime pack is not built in the scriptc checkout." >&2
    echo "ios control: build it there with 'pnpm --filter @scriptc/$PACK build:native' (macOS + Xcode), then rerun." >&2
  fi
  echo "ios control: scriptc build for $TARGET failed; no archive staged" >&2
  exit 1
fi
cat "$LOG"
[[ -f "$ARCHIVE" ]] || { echo "ios control: scriptc reported success but $ARCHIVE is missing" >&2; exit 1; }

# Every symbol the generated header declares must be defined by the archive.
DEFINED="$(nm -gU "$ARCHIVE" 2>/dev/null | awk '{print $NF}' | sort -u)"
for symbol in $(sed -nE 's/^[a-z0-9_ *]+[ *](nt_control_[a-z_]+)\(.*/\1/p' "$ROOT/ipc/control.generated.h"); do
  grep -qx "_$symbol" <<<"$DEFINED" || { echo "ios control: archive lacks $symbol" >&2; exit 1; }
done
# Every member must be built for the requested Apple platform (7 simulator, 2 device).
PLATFORMS="$(otool -l "$ARCHIVE" | awk '/cmd LC_BUILD_VERSION/{b=1} b&&/platform/{print $2; b=0}' | sort -u | tr '\n' ' ')"
[[ "$PLATFORMS" == "$PLATFORM " ]] || { echo "ios control: archive platforms '$PLATFORMS' do not match $SDK ($PLATFORM)" >&2; exit 1; }
MINOS="$(otool -l "$ARCHIVE" | awk '/cmd LC_BUILD_VERSION/{b=1} b&&/minos/{print $2; b=0}' | sort -u | tr '\n' ' ')"
lipo -info "$ARCHIVE" | grep -q 'arm64' || { echo "ios control: archive is not arm64" >&2; exit 1; }

mkdir -p "$OUT"
cp "$ARCHIVE" "$OUT/libntcontrol.a"
SCRIPTC_ENTRY="${SCRIPTC:-$ROOT/../../scriptc/packages/cli/dist/main.js}"
VERSION="$(node "$SCRIPTC_ENTRY" --version 2>/dev/null || echo unknown)"
python3 - "$OUT/archive.json" "$TARGET" "$SDK" "$VERSION" "$MINOS" "$OUT/libntcontrol.a" "$ROOT/ipc/control-profile.json" "$ROOT/ipc/control.ts" <<'PY'
import hashlib, json, sys
out, target, sdk, version, minos, archive, profile, source = sys.argv[1:]
digest = lambda path: hashlib.sha256(open(path, 'rb').read()).hexdigest()
json.dump({"target": target, "sdk": sdk, "scriptc": version, "minos": minos.split(),
           "archive": {"sha256": digest(archive)}, "profile": {"sha256": digest(profile)},
           "source": {"sha256": digest(source)}}, open(out, 'w'), indent=2, sort_keys=True)
PY
echo "ios control: staged $OUT/libntcontrol.a ($TARGET, minos ${MINOS% }, scriptc $VERSION)"
