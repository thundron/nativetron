#!/usr/bin/env bash
# Builds the native protocol-3 executor and its drivers against the pinned wgpu-native (macOS arm64).
#   gpu/native/build-executor.sh [--sanitize address|thread] [--conformance]
# Products in the build directory (printed on the last line of stdout):
#   libntgpu-executor.a          executor.o + ntgpu.o (link with libwgpu_native.a and the frameworks below)
#   ntgpu-executor-driver        line-protocol driver used by executor.test.mjs and executor-corpus.mjs
#   ntgpu-executor-conformance   gpu/conformance.ts compiled natively by scriptc and linked to the executor
#                                (only with --conformance; needs $SCRIPTC, a read-only scriptc CLI)
# Environment:
#   NT_NATIVE_GPU_DEPS        dependency cache (default /tmp/nt-native-gpu-deps; verified by fetch-deps.sh --offline
#                             when present, otherwise fetched)
#   NTGPU_WGPU_LIB            static wgpu-native library to link instead of the pinned one (for example a build with
#                             a patched Naga); headers still come from the pinned prefix
#   NTGPU_EXECUTOR_BUILD_DIR  output directory (default $NT_NATIVE_GPU_DEPS/build/macos-arm64-executor[-sanitizer]);
#                             never inside the worktree. The conformance reactor is compiled under it too.
#   SCRIPTC                   scriptc CLI (default <nativetron>/../../scriptc/packages/cli/dist/main.js, as gpu/build.sh)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GPU="$(cd "$HERE/.." && pwd)"
SANITIZE=
CONFORMANCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sanitize) SANITIZE="$2"; shift 2 ;;
    --conformance) CONFORMANCE=1; shift ;;
    *) echo "build-executor: unknown argument $1" >&2; exit 2 ;;
  esac
done
DEPS="${NT_NATIVE_GPU_DEPS:-/tmp/nt-native-gpu-deps}"
if PREFIX="$("$HERE/fetch-deps.sh" --offline 2>/dev/null)"; then :; else PREFIX="$("$HERE/fetch-deps.sh")"; fi
WGPU_LIB="${NTGPU_WGPU_LIB:-$PREFIX/lib/libwgpu_native.a}"
[[ -f "$WGPU_LIB" ]] || { echo "build-executor: missing $WGPU_LIB" >&2; exit 2; }
OUT="${NTGPU_EXECUTOR_BUILD_DIR:-$DEPS/build/macos-arm64-executor${SANITIZE:+-$SANITIZE}}"
case "$OUT" in "$GPU"/*|"$(cd "$GPU/.." && pwd)"/*) echo "build-executor: output must be outside the worktree" >&2; exit 2 ;; esac
mkdir -p "$OUT/obj"
# Concurrent test files share the output directory: build under a lock (released on exit).
LOCK="$OUT/.build-lock"
for _ in $(seq 1 1200); do mkdir "$LOCK" 2>/dev/null && break; sleep 0.25; done
[[ -d "$LOCK" ]] || { echo "build-executor: could not lock $OUT" >&2; exit 2; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
TARGET=arm64-apple-macos14.0
CXXFLAGS=(-std=c++17 -O2 -g -Wall -Wextra -Werror -target "$TARGET" -I"$PREFIX/include" -I"$HERE")
LDFLAGS=()
case "$SANITIZE" in
  "") ;;
  address) CXXFLAGS+=(-fsanitize=address,undefined -fno-omit-frame-pointer); LDFLAGS+=(-fsanitize=address,undefined) ;;
  thread) CXXFLAGS+=(-fsanitize=thread -fno-omit-frame-pointer); LDFLAGS+=(-fsanitize=thread) ;;
  *) echo "build-executor: --sanitize address|thread" >&2; exit 2 ;;
esac
FRAMEWORKS=(-framework Metal -framework QuartzCore -framework Foundation -framework CoreFoundation -lobjc -liconv)
xcrun clang++ "${CXXFLAGS[@]}" -c "$HERE/ntgpu.cc" -o "$OUT/obj/ntgpu.o"
xcrun clang++ "${CXXFLAGS[@]}" -c "$HERE/executor.cc" -o "$OUT/obj/executor.o"
xcrun clang++ "${CXXFLAGS[@]}" -c "$HERE/executor-driver.cc" -o "$OUT/obj/executor-driver.o"
xcrun clang++ "${CXXFLAGS[@]}" -fobjc-arc -c "$HERE/executor-layer-darwin.mm" -o "$OUT/obj/executor-layer-darwin.o"
rm -f "$OUT/libntgpu-executor.a"
xcrun ar rcs "$OUT/libntgpu-executor.a" "$OUT/obj/executor.o" "$OUT/obj/ntgpu.o"
xcrun clang++ -target "$TARGET" ${LDFLAGS[@]+"${LDFLAGS[@]}"} -Wl,-dead_strip "$OUT/obj/executor-driver.o" "$OUT/obj/executor-layer-darwin.o" \
  "$OUT/libntgpu-executor.a" "$WGPU_LIB" "${FRAMEWORKS[@]}" -o "$OUT/ntgpu-executor-driver"
if [[ "$CONFORMANCE" == 1 ]]; then
  SCRIPTC="${SCRIPTC:-$GPU/../../../scriptc/packages/cli/dist/main.js}"
  [[ -f "$SCRIPTC" ]] || { echo "build-executor: SCRIPTC not found ($SCRIPTC)" >&2; exit 2; }
  SRC="$OUT/conformance-src"
  rm -rf "$SRC" && mkdir -p "$SRC" "$OUT/scriptc-cache" "$OUT/scriptc-state" "$OUT/scriptc-tmp"
  cp "$GPU/conformance.ts" "$GPU/index.ts" "$GPU/encode.ts" "$GPU/gpu.generated.ts" "$GPU/limits.generated.ts" \
     "$GPU/conformance-profile.json" "$SRC/"
  (cd "$SRC" && SCRIPTC_CACHE_DIR="$OUT/scriptc-cache" SCRIPTC_STATE_DIR="$OUT/scriptc-state" TMPDIR="$OUT/scriptc-tmp" \
     node "$SCRIPTC" build --lib --profile conformance-profile.json -o "$OUT/libntconf.a" > "$OUT/conformance-build.log" 2>&1) \
    || { cat "$OUT/conformance-build.log" >&2; exit 1; }
  xcrun clang++ "${CXXFLAGS[@]}" -c "$HERE/executor-conformance.cc" -o "$OUT/obj/executor-conformance.o"
  xcrun clang++ -target "$TARGET" ${LDFLAGS[@]+"${LDFLAGS[@]}"} -Wl,-dead_strip "$OUT/obj/executor-conformance.o" \
    "$OUT/libntconf.a" "$OUT/libntgpu-executor.a" "$WGPU_LIB" "${FRAMEWORKS[@]}" -o "$OUT/ntgpu-executor-conformance"
fi
printf '%s\n' "$OUT"
