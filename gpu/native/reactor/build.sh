#!/usr/bin/env bash
# Builds the native reactor host (macOS arm64).
#   gpu/native/reactor/build.sh [--out DIR] [--sanitize address|undefined]
#        [--engine-archive hp-engine.lib.a]                 also link the engine statically (nt-reactor-linked, engine native:linked)
#        [--executor-archive lib.a ... | --executor-src file.cc ...] [--executor-cxxflags "..."] [--executor-ldflags "..."]
#                                                            also link an executor statically (nt-reactor-linked, --executor-lib linked)
# Products in $OUT (default $NT_REACTOR_BUILD_DIR or /tmp/nt-reactor-e2e/build), never inside the worktree:
#   nt-reactor                      host CLI; loads the engine (native:<dylib>, wasm:<dir>) and the executor (--executor-lib <dylib>) at run time
#   libntgpu-executor-mock.dylib    MOCK executor (recording double; no GPU, no pixels) for host development and regressions
#   nt-reactor-linked               only with --engine-archive / --executor-*: the same CLI with them linked in
#   libntgpu-executor.dylib         only with --executor-archive/--executor-src: the executor (first archive force-loaded,
#                                   later archives such as libwgpu_native.a resolved normally) as a dylib exporting only
#                                   ntgpu_executor_*, for `nt-reactor run --executor-lib` (and any other host)
# Typical real-executor link (sibling executor archive + the pinned or patched wgpu-native override):
#   build.sh --executor-archive <build>/libntgpu-executor.a --executor-archive <wgpu prefix>/lib/libwgpu_native.a \
#            --executor-ldflags "-framework Metal -framework QuartzCore -framework Foundation -framework CoreFoundation -lobjc -liconv"
# The last line of stdout is $OUT.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${NT_REACTOR_BUILD_DIR:-/tmp/nt-reactor-e2e/build}"
SANITIZE=
ENGINE_ARCHIVE=
EXEC_ARCHIVES=()
EXEC_SRCS=()
EXEC_CXXFLAGS=
EXEC_LDFLAGS=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --sanitize) SANITIZE="$2"; shift 2 ;;
    --engine-archive) ENGINE_ARCHIVE="$2"; shift 2 ;;
    --executor-archive) EXEC_ARCHIVES+=("$2"); shift 2 ;;
    --executor-src) EXEC_SRCS+=("$2"); shift 2 ;;
    --executor-cxxflags) EXEC_CXXFLAGS="$2"; shift 2 ;;
    --executor-ldflags) EXEC_LDFLAGS="$2"; shift 2 ;;
    *) echo "build: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$OUT" in "$HERE"*|"$(cd "$HERE/../../.." && pwd)"*) echo "build: --out must be outside the repository" >&2; exit 2 ;; esac
mkdir -p "$OUT/obj"
TARGET=arm64-apple-macos14.0
CFLAGS=(-std=c11 -O2 -g -Wall -Wextra -Werror -target "$TARGET" -DNT_REACTOR_SOURCE_DIR="\"$HERE\"")
CXXFLAGS=(-std=c++17 -O2 -g -Wall -Wextra -Werror -target "$TARGET")
LDFLAGS=(-target "$TARGET")
case "$SANITIZE" in
  "") ;;
  address|undefined) CFLAGS+=(-fsanitize="$SANITIZE" -fno-omit-frame-pointer); CXXFLAGS+=(-fsanitize="$SANITIZE"); LDFLAGS+=(-fsanitize="$SANITIZE") ;;
  *) echo "build: --sanitize address|undefined" >&2; exit 2 ;;
esac
SRCS=(reactor json guest-native guest-pipe cli)
for s in "${SRCS[@]}"; do xcrun clang "${CFLAGS[@]}" -c "$HERE/$s.c" -o "$OUT/obj/$s.o"; done
OBJS=("${SRCS[@]/#/$OUT/obj/}"); OBJS=("${OBJS[@]/%/.o}")
xcrun clang "${LDFLAGS[@]}" "${OBJS[@]}" -o "$OUT/nt-reactor"
xcrun clang++ "${CXXFLAGS[@]}" -fvisibility=hidden -dynamiclib -install_name @rpath/libntgpu-executor-mock.dylib \
  "$HERE/mock-executor.cc" -o "$OUT/libntgpu-executor-mock.dylib"
if [[ -n "$ENGINE_ARCHIVE" || ${#EXEC_ARCHIVES[@]} -gt 0 || ${#EXEC_SRCS[@]} -gt 0 ]]; then
  EXTRA=()
  if [[ -n "$ENGINE_ARCHIVE" ]]; then
    # archive member selection (not -force_load: the pruned runtime archive leaves unrelated members unresolved)
    for sym in init sink callback collect start frame event message receive readback; do EXTRA+=(-Wl,-u,_hp_$sym); done
    EXTRA+=("$ENGINE_ARCHIVE")
  fi
  if [[ ${#EXEC_SRCS[@]} -gt 0 ]]; then
    i=0
    for s in "${EXEC_SRCS[@]}"; do
      # shellcheck disable=SC2086
      xcrun clang++ -std=c++17 -O2 -g -target "$TARGET" -I"$HERE/.." -I"$HERE/../.." $EXEC_CXXFLAGS -c "$s" -o "$OUT/obj/executor-$i.o"
      EXTRA+=("$OUT/obj/executor-$i.o"); i=$((i + 1))
    done
  fi
  if [[ ${#EXEC_ARCHIVES[@]} -gt 0 || ${#EXEC_SRCS[@]} -gt 0 ]]; then
    for sym in create destroy submit process pending resize capture_rgba; do EXTRA+=(-Wl,-u,_ntgpu_executor_$sym); done
    EXTRA+=(${EXEC_ARCHIVES[@]+"${EXEC_ARCHIVES[@]}"})
  fi
  # shellcheck disable=SC2086
  xcrun clang++ "${LDFLAGS[@]}" "${OBJS[@]}" "${EXTRA[@]}" $EXEC_LDFLAGS -o "$OUT/nt-reactor-linked"
fi
if [[ ${#EXEC_ARCHIVES[@]} -gt 0 || ${#EXEC_SRCS[@]} -gt 0 ]]; then
  DYL=()
  for o in "$OUT"/obj/executor-*.o; do [[ -f "$o" && ${#EXEC_SRCS[@]} -gt 0 ]] && DYL+=("$o"); done
  first=1
  for a in ${EXEC_ARCHIVES[@]+"${EXEC_ARCHIVES[@]}"}; do
    if [[ $first == 1 && ${#EXEC_SRCS[@]} -eq 0 ]]; then DYL+=(-Wl,-force_load,"$a"); else DYL+=("$a"); fi
    first=0
  done
  # shellcheck disable=SC2086
  xcrun clang++ "${LDFLAGS[@]}" -dynamiclib -install_name @rpath/libntgpu-executor.dylib "${DYL[@]}" $EXEC_LDFLAGS \
    -Wl,-exported_symbol,'_ntgpu_executor_*' -o "$OUT/libntgpu-executor.dylib"
fi
printf '%s\n' "$OUT"
