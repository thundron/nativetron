#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${WEBVIEW2_SDK:?set WEBVIEW2_SDK to the extracted Microsoft.Web.WebView2 SDK directory}"
cd "$ROOT"
engine/build.sh --web
node ipc/generate-engine.mjs --check
# Zig's bundled MinGW toolchain; WebView2's installed platform runtime is loaded by webview/webview.
zig c++ -target x86_64-windows-gnu -std=c++17 -O2 -fms-extensions \
  -I hosts/windows/include -I native/vendor/webview/include -I "$WEBVIEW2_SDK/build/native/include" \
  hosts/windows/main.cc -lole32 -lshell32 -lshlwapi -luser32 -lversion -luuid -lcomdlg32 -lgdi32 \
  -o build/engine-windows.exe
