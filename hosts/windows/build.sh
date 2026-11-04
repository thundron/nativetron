#!/usr/bin/env bash
# Cross-builds build/engine-windows.exe (x86-64, WebView2 via webview/webview's
# built-in loader) next to build/engine-assets, after running the portable
# policy tests on the build machine. `--check` also runs verify.test.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${WEBVIEW2_SDK:?set WEBVIEW2_SDK to the extracted Microsoft.Web.WebView2 SDK directory}"
HEADER="$WEBVIEW2_SDK/build/native/include/WebView2.h"
[[ -f "$HEADER" ]] || { echo "WebView2.h not found under $WEBVIEW2_SDK/build/native/include" >&2; exit 1; }
# ICoreWebView2_22 (request source kinds) and Settings8 are compiled in; SDKs older than 1.0.2739 lack them.
grep -q "ICoreWebView2_22" "$HEADER" || { echo "WebView2 SDK too old: ICoreWebView2_22 required" >&2; exit 1; }
if [[ -f "$WEBVIEW2_SDK/Microsoft.Web.WebView2.nuspec" ]]; then
  echo "WebView2 SDK $(sed -n 's:.*<version>\(.*\)</version>.*:\1:p' "$WEBVIEW2_SDK/Microsoft.Web.WebView2.nuspec" | head -1)"
fi
cd "$ROOT"
engine/build.sh --web
node ipc/generate-engine.mjs --check
mkdir -p build

# Portable policy: origin, paths, MIME/headers, IPC, menu, DPI, self-test state machine.
NATIVE_CXX="${CXX:-c++}"
command -v "$NATIVE_CXX" >/dev/null 2>&1 || NATIVE_CXX="zig c++"
$NATIVE_CXX -std=c++17 -O1 -Wall -Wextra -Werror -I native/vendor/webview/include \
  hosts/windows/policy.test.cc -o build/windows-policy-test
(cd build/engine-assets && find . -type f | sed 's|^\./||' | LC_ALL=C sort | xargs ../windows-policy-test)

# Zig's bundled MinGW toolchain; WebView2's installed platform runtime is loaded by webview/webview.
zig c++ -target x86_64-windows-gnu -std=c++17 -O2 -fms-extensions -Wall -Wno-unknown-pragmas \
  -I hosts/windows/include -I native/vendor/webview/include -I "$WEBVIEW2_SDK/build/native/include" \
  hosts/windows/main.cc -lole32 -lshell32 -lshlwapi -luser32 -lversion -luuid -lcomdlg32 -lgdi32 -ladvapi32 \
  -o build/engine-windows.exe
node hosts/windows/pe.mjs build/engine-windows.exe

if [[ "${1:-}" == "--check" ]]; then
  NT_WINDOWS_REQUIRE_EXE=1 node --test hosts/windows/verify.test.mjs
fi
