#!/usr/bin/env bash
# Builds the ntgpu facade (libntgpu.a) and the ntgpu-probe CLI against the pinned wgpu-native (macOS arm64 only).
#   gpu/native/build.sh [--link static|dynamic] [--sanitize address|thread] [--wgpu official|patched]
#   --wgpu (default $NTGPU_WGPU_VARIANT, else official) selects the wgpu-native prefix from fetch-deps.sh --variant;
#   the patched variant's products go to their own build directory (suffix -<variant name>).
# Products: libntgpu.a, ntgpu-probe, swift-smoke (last line of stdout is the ntgpu-probe path).
# Output: $NTGPU_BUILD_DIR (default /tmp/nt-native-gpu-deps/build/macos-arm64-<link>), never inside the worktree.
#   static : libwgpu_native.a linked into the executable with -dead_strip (default; what an app host would ship)
#   dynamic: links libwgpu_native.dylib from the dependency cache through an absolute LC_RPATH (development only;
#            a bundle would copy the dylib to Contents/Frameworks and use @executable_path/../Frameworks)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LINK=static
SANITIZE=
VARIANT="${NTGPU_WGPU_VARIANT:-official}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --link) LINK="$2"; shift 2 ;;
    --sanitize) SANITIZE="$2"; shift 2 ;;
    --wgpu) VARIANT="$2"; shift 2 ;;
    *) echo "build: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ "$LINK" == static || "$LINK" == dynamic ]] || { echo "build: --link static|dynamic" >&2; exit 2; }
PREFIX="$("$HERE/fetch-deps.sh" --variant "$VARIANT")"
DEPS="${NT_NATIVE_GPU_DEPS:-/tmp/nt-native-gpu-deps}"
SUFFIX="$LINK${SANITIZE:+-$SANITIZE}"
if [[ "$VARIANT" == patched ]]; then
  SUFFIX="$SUFFIX-$(sed -n 's/^PATCHED_VARIANT=//p' "$HERE/compiler/wgpu-native-patched.lock")"
fi
OUT="${NTGPU_BUILD_DIR:-$DEPS/build/macos-arm64-$SUFFIX}"
mkdir -p "$OUT/obj"
TARGET=arm64-apple-macos14.0
CXXFLAGS=(-std=c++17 -O2 -g0 -Wall -Wextra -Werror -target "$TARGET" -I"$PREFIX/include" -I"$HERE")
LDFLAGS=()
SWIFT_SANITIZE=()
case "$SANITIZE" in
  "") ;;
  address) CXXFLAGS+=(-fsanitize=address,undefined -fno-omit-frame-pointer); LDFLAGS+=(-fsanitize=address,undefined)
           SWIFT_SANITIZE=(-sanitize=address) ;;
  thread) CXXFLAGS+=(-fsanitize=thread -fno-omit-frame-pointer); LDFLAGS+=(-fsanitize=thread)
          SWIFT_SANITIZE=(-sanitize=thread) ;;
  *) echo "build: --sanitize address|thread" >&2; exit 2 ;;
esac
xcrun clang++ "${CXXFLAGS[@]}" -c "$HERE/ntgpu.cc" -o "$OUT/obj/ntgpu.o"
xcrun clang++ "${CXXFLAGS[@]}" -c "$HERE/probe.cc" -o "$OUT/obj/probe.o"
xcrun clang++ "${CXXFLAGS[@]}" -fobjc-arc -c "$HERE/probe-surface-darwin.mm" -o "$OUT/obj/probe-surface-darwin.o"
rm -f "$OUT/libntgpu.a"
xcrun ar rcs "$OUT/libntgpu.a" "$OUT/obj/ntgpu.o"
FRAMEWORKS=(-framework Metal -framework QuartzCore -framework Foundation -framework CoreFoundation -lobjc -liconv)
if [[ "$LINK" == static ]]; then
  WGPU=("$PREFIX/lib/libwgpu_native.a")
  SWIFT_WGPU=("${WGPU[@]}")
else
  WGPU=(-L"$PREFIX/lib" -lwgpu_native -Wl,-rpath,"$PREFIX/lib")
  SWIFT_WGPU=(-L"$PREFIX/lib" -lwgpu_native -Xlinker -rpath -Xlinker "$PREFIX/lib")
fi
xcrun clang++ -target "$TARGET" ${LDFLAGS[@]+"${LDFLAGS[@]}"} -Wl,-dead_strip "$OUT/obj/probe.o" "$OUT/obj/probe-surface-darwin.o" "$OUT/libntgpu.a" \
  "${WGPU[@]}" "${FRAMEWORKS[@]}" -o "$OUT/ntgpu-probe"
[[ -n "$SANITIZE" ]] || xcrun strip -x "$OUT/ntgpu-probe"
# Swift host smoke binary (the macOS host is Swift): imports the facade through module.modulemap.
xcrun swiftc -swift-version 5 -O -target "$TARGET" ${SWIFT_SANITIZE[@]+"${SWIFT_SANITIZE[@]}"} -I "$HERE" -I "$PREFIX/include" \
  -module-cache-path "$OUT/swift-module-cache" "$HERE/swift-smoke.swift" "$OUT/libntgpu.a" "${SWIFT_WGPU[@]}" \
  "${FRAMEWORKS[@]}" -o "$OUT/swift-smoke"
printf '%s\n' "$OUT/ntgpu-probe"
