#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d -t nt-apple-services.XXXXXX)"
trap 'rm -rf "$OUT"' EXIT
xcrun swiftc -swift-version 5 "$HERE"/{ArchiveStore,HostFileNames}.swift "$HERE/archive-store.test.swift" -o "$OUT/archive"
"$OUT/archive"
xcrun swiftc -swift-version 5 "$HERE"/{ArchiveStore,HostFileNames,HostMediaResource,HostPDFLayout,HostPowerState}.swift "$HERE/media-power-pdf.test.swift" -o "$OUT/services"
"$OUT/services"
