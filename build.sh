#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../scriptc/packages/cli/dist/main.js}"
WV_INC="$ROOT/native/vendor/webview/include"
mkdir -p "$ROOT/build"

node "$ROOT/abi/generate.mjs" --check
node "$ROOT/canvas/generate.mjs" --check

# Platform link flags for the webview library (injected into scriptc's clang
# link step via the clang-driver CCC_OVERRIDE_OPTIONS hook; '+' appends args).
case "$(uname -s)" in
  Darwin) LINK='+-lc++ +-framework +WebKit +-framework +Cocoa' ;;
  Linux)  LINK="$(pkg-config --libs gtk+-3.0 webkit2gtk-4.1 2>/dev/null | sed 's/ */ +/g; s/^/+/')" ;;
  *) LINK='' ;;
esac

echo "[1/3] generate host-embed (single source: host/dom-host.js)"
mkdir -p "$ROOT/framework"
node -e 'const fs=require("fs");const js=fs.readFileSync(process.argv[1],"utf8");fs.writeFileSync(process.argv[2],"// AUTO-GENERATED from host/dom-host.js by build.sh — do not edit.\nexport const HOST_JS = "+JSON.stringify(js)+";\n")' "$ROOT/host/dom-host.js" "$ROOT/framework/host-embed.generated.ts"

echo "[1/3] native core -> native/nativetron_core.o"
clang++ -std=c++17 -O2 -I "$WV_INC" -c "$ROOT/native/nativetron_core.cc" \
  -o "$ROOT/native/nativetron_core.o"

echo "[2/3] renderer.ts -> build/renderer (native)"
cd "$ROOT"
CCC_OVERRIDE_OPTIONS="$LINK" \
  node "$SCRIPTC" build app/renderer.ts --backend c \
    --ffi ffi/nativetron.ffi.json -o build/renderer

echo "[3/3] main.ts -> build/main (native)"
node "$SCRIPTC" build app/main.ts --backend c -o build/main

echo "OK -> $ROOT/build/main (spawns build/renderer)"

# ---------------------------------------------------------------------------
# Optional: headless NATIVE self-test of the compile-time-reactive core (no GUI,
# no FFI). Proves signals/effects work and matches the recorded expected output.
# Not part of the default build. Run manually with:
#
#   node "$SCRIPTC" build framework/reactive.selftest.ts --backend c \
#     -o build/reactive-selftest && ./build/reactive-selftest \
#     | diff - framework/reactive.selftest.expected.txt && echo "reactive selftest OK"
