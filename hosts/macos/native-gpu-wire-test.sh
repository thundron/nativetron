#!/usr/bin/env bash
# Swift half of the native GPU wire (NativeGPUWire.swift): framing, bounds, zero-copy slicing. No GPU, no WebKit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d -t nt-native-gpu-wire.XXXXXX)"
trap 'rm -rf "$OUT"' EXIT
mkdir -p "$OUT/src"
cp "$HERE/NativeGPUWire.swift" "$OUT/src/NativeGPUWire.swift"
cp "$HERE/native-gpu-wire.test.swift" "$OUT/src/main.swift"
xcrun swiftc -swift-version 5 -warnings-as-errors -target "$(uname -m)-apple-macos14.0" "$OUT/src/NativeGPUWire.swift" "$OUT/src/main.swift" -o "$OUT/native-gpu-wire"
"$OUT/native-gpu-wire"
