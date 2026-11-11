#!/usr/bin/env bash
# Unsigned WKWebView host. No Dawn, bundled browser, or signing identity.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
if [[ "${NT_MACOS_SKIP_ENGINE:-0}" != 1 ]]; then engine/build.sh --web; fi
node engine/generate-assets.mjs --check
node ipc/generate-engine.mjs --check
OUT="$ROOT/build/macos/Nativetron.app"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
rm -rf "$OUT/Contents/Resources/engine-assets"
cp -R build/engine-assets "$OUT/Contents/Resources/engine-assets"
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
swiftc -swift-version 5 -O -target "$(uname -m)-apple-macos14.0" \
  hosts/macos/{Main,SelfTest}.swift hosts/apple/{ArchiveStore,HostServices,HostPDFJob}.swift \
  hosts/ios/Sources/{AssetCatalog,AssetSchemeHandler,BundledAssets.generated,EngineProtocol.generated,Evidence}.swift \
  -o "$OUT/Contents/MacOS/Nativetron"
printf '%s\n' "$OUT"
