#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../scriptc/packages/cli/dist/main.js}"
cd "$ROOT"
node abi/generate.mjs --check
node ipc/generate-engine.mjs --check
node gpu/generate.mjs --check
./gpu/build.sh
(cd engine && SCRIPTC_TARGET=wasm32-wasi SCRIPTC_CC=zigcc node "$SCRIPTC" build --lib --profile ui-profile.json)
node engine/package.mjs
if [[ "${1:-}" == "--web" ]]; then exit 0; fi
if [[ "$(uname -s)" != "Darwin" ]]; then echo 'desktop engine build currently requires macOS' >&2; exit 1; fi
mkdir -p build
clang++ -std=c++17 -O2 -DNT_ASSET_HOST -I native/vendor/webview/include -c native/nativetron_core.cc -o build/engine-core.o
clang++ -std=c++17 -O2 -fobjc-arc -c native/assets-darwin.mm -o build/engine-assets.o
clang++ -std=c++17 -O2 -fobjc-arc -c engine/menu-selftest.mm -o build/engine-menu-selftest.o
node - <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const spec = JSON.parse(fs.readFileSync('ffi/nativetron.ffi.json', 'utf8'));
spec.functions.push(
  { name: 'ntAssetsConfigure', symbol: 'nt_assets_configure', params: ['string', 'string', 'i32'], returns: 'i32' },
  { name: 'ntEngineMenuSelftest', symbol: 'nt_engine_menu_selftest', params: [], returns: 'i32' },
);
spec.libraries = ['engine-core.o', 'engine-assets.o', 'engine-menu-selftest.o'].map(file => path.resolve('build', file));
fs.writeFileSync('build/engine.ffi.json', JSON.stringify(spec, null, 2) + '\n');
const js = fs.readFileSync('host/dom-host.js', 'utf8');
fs.writeFileSync('framework/host-embed.generated.ts', '// AUTO-GENERATED from host/dom-host.js by build.sh — do not edit.\nexport const HOST_JS = ' + JSON.stringify(js) + ';\n');
JS
CCC_OVERRIDE_OPTIONS='+-lc++ +-framework +WebKit +-framework +Cocoa +-framework +Carbon +-framework +UserNotifications' \
  node "$SCRIPTC" build engine/desktop.ts --backend llvm --ffi build/engine.ffi.json -o build/engine-desktop
