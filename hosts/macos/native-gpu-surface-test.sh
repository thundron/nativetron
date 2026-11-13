#!/usr/bin/env bash
# Deterministic NativeGPUSurface tests: geometry, scheduler, AppKit lifecycle.
# No GPU device is created, no window is shown, nothing is signed. Outputs live
# in a private temp dir that is always removed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d -t nt-native-gpu-surface.XXXXXX)"
trap 'rm -rf "$OUT"' EXIT
for arch in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -typecheck -warnings-as-errors -target "$arch-apple-macos14.0" "$HERE/NativeGPUSurface.swift"
done
xcrun swiftc -swift-version 6 -typecheck -target "$(uname -m)-apple-macos14.0" "$HERE/NativeGPUSurface.swift"
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macos14.0" \
  "$HERE/NativeGPUSurface.swift" "$HERE/native-gpu-surface.test.swift" -o "$OUT/native-gpu-surface"
"$OUT/native-gpu-surface"
