#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../scriptc/packages/cli/dist/main.js}"
WV_INC="$ROOT/native/vendor/webview/include"
OUT="$ROOT/bench/desktop-app/build"
mkdir -p "$OUT" "$ROOT/framework"

case "$(uname -s)" in
  Darwin) LINK='+-lc++ +-framework +WebKit +-framework +Cocoa +-framework +Carbon +-framework +UserNotifications' ;;
  Linux) LINK="$(pkg-config --libs gtk+-3.0 webkit2gtk-4.1 2>/dev/null | sed 's/ */ +/g; s/^/+/')" ;;
  *) LINK='' ;;
esac

node "$ROOT/abi/generate.mjs" --check
node -e 'const fs=require("fs");const js=fs.readFileSync(process.argv[1],"utf8");fs.writeFileSync(process.argv[2],"// AUTO-GENERATED from host/dom-host.js by build.sh — do not edit.\nexport const HOST_JS = "+JSON.stringify(js)+";\n")' "$ROOT/host/dom-host.js" "$ROOT/framework/host-embed.generated.ts"
clang++ -std=c++17 -O2 -I "$WV_INC" -c "$ROOT/native/nativetron_core.cc" -o "$ROOT/native/nativetron_core.o"

cd "$ROOT"
CCC_OVERRIDE_OPTIONS="$LINK" node "$SCRIPTC" build bench/desktop-app/renderer.ts --backend c --ffi ffi/nativetron.ffi.json -o "$OUT/renderer"
node "$SCRIPTC" build bench/desktop-app/main.ts --backend c -o "$OUT/main"
echo "built desktop benchmark app"
