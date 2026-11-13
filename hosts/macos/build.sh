#!/usr/bin/env bash
# Unsigned WKWebView host. No Dawn, bundled browser, or signing identity.
#   NT_MACOS_BUILD_DIR   output root (default build/macos); the app is $NT_MACOS_BUILD_DIR/Nativetron.app
#   NT_MACOS_SKIP_ENGINE=1   reuse build/engine-assets instead of running engine/build.sh --web
#   NT_MACOS_WASM_ROOT=DIR   stage engine assets into the output root from this tree's sources plus the
#                            prebuilt .scriptc outputs of DIR (read-only; nothing is written into the worktree)
#   NT_GPU_EXECUTOR_LIBS="a.a b.a ..."   link a gpu/native/executor.h implementation (plus its dependencies);
#                            without it the native GPU path is built against an unlinked stub that never executes
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
BUILD="${NT_MACOS_BUILD_DIR:-$ROOT/build/macos}"
OUT="$BUILD/Nativetron.app"
ASSETS="$ROOT/build/engine-assets"
if [[ -n "${NT_MACOS_WASM_ROOT:-}" ]]; then
  ASSETS="$BUILD/engine-assets"
  NT_ASSETS_OUT="$ASSETS" NT_WASM_ROOT="$NT_MACOS_WASM_ROOT" node - <<'JS'
const fs = require("node:fs"), path = require("node:path");
const out = process.env.NT_ASSETS_OUT, wasm = process.env.NT_WASM_ROOT;
const manifest = JSON.parse(fs.readFileSync("engine/assets.json", "utf8"));
fs.rmSync(out, { recursive: true, force: true });
for (const { path: file } of manifest.files) {
  const source = file.includes(".scriptc/") ? path.join(wasm, file) : file;
  fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
  fs.copyFileSync(source, path.join(out, file));
}
fs.writeFileSync(path.join(out, "asset-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
JS
elif [[ "${NT_MACOS_SKIP_ENGINE:-0}" != 1 ]]; then engine/build.sh --web; fi
node engine/generate-assets.mjs --check
node ipc/generate-engine.mjs --check
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources" "$BUILD/obj"
rm -rf "$OUT/Contents/Resources/engine-assets" "$OUT/Contents/Resources/native-gpu-selftest"
cp -R "$ASSETS" "$OUT/Contents/Resources/engine-assets"
# Test-only resources for --native-gpu-selftest=wire (served under /__ntgpu/ only in that mode).
mkdir -p "$OUT/Contents/Resources/native-gpu-selftest"
cp hosts/macos/native-gpu-wire-selftest.html hosts/macos/native-gpu-wire-selftest.js "$OUT/Contents/Resources/native-gpu-selftest/"
cat > "$OUT/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.nativetron.macos</string>
<key>CFBundleName</key><string>Nativetron</string>
<key>CFBundleExecutable</key><string>Nativetron</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPhotoLibraryUsageDescription</key><string>Choose images and videos for your project.</string>
<key>NSPhotoLibraryAddUsageDescription</key><string>Save exported images and videos to your photo library.</string>
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>Nativetron Project</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSItemContentTypes</key><array><string>dev.nativetron.project</string></array></dict></array>
<key>UTExportedTypeDeclarations</key><array><dict><key>UTTypeIdentifier</key><string>dev.nativetron.project</string><key>UTTypeConformsTo</key><array><string>public.data</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>ntproject</string></array><key>public.mime-type</key><string>application/vnd.nativetron.project</string></dict></dict></array>
</dict></plist>
PLIST
TARGET="$(uname -m)-apple-macos14.0"
EXECUTOR=()
LINKAGE=hosts/macos/native-gpu-executor-unlinked.c
if [[ -n "${NT_GPU_EXECUTOR_LIBS:-}" ]]; then
  read -r -a EXECUTOR <<<"$NT_GPU_EXECUTOR_LIBS"
  EXECUTOR+=(-framework Metal -framework QuartzCore -lc++)
  LINKAGE=hosts/macos/native-gpu-executor-linked.c
fi
xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -target "$TARGET" -c "$LINKAGE" -o "$BUILD/obj/native-gpu-linkage.o"
xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -target "$TARGET" -c hosts/macos/native-gpu-recorder.c -o "$BUILD/obj/native-gpu-recorder.o"
swiftc -swift-version 5 -O -target "$TARGET" -import-objc-header hosts/macos/NativeGPU-Bridging.h \
  -module-cache-path "$BUILD/swift-module-cache" \
  hosts/macos/{Main,SelfTest,NativeGPUSurface,NativeGPUWire,NativeGPUBridge,MacSchemeRouter,NativeGPUSelfTest}.swift \
  hosts/apple/{ArchiveStore,HostFileNames,HostMediaResource,HostPowerState,HostPDFLayout,HostServices,HostPDFJob}.swift \
  hosts/ios/Sources/{AssetCatalog,AssetSchemeHandler,BundledAssets.generated,EngineProtocol.generated,Evidence}.swift \
  "$BUILD/obj/native-gpu-linkage.o" "$BUILD/obj/native-gpu-recorder.o" ${EXECUTOR[@]+"${EXECUTOR[@]}"} \
  -o "$OUT/Contents/MacOS/Nativetron"
printf '%s\n' "$OUT"
