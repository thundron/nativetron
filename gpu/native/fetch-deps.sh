#!/usr/bin/env bash
# Fetches and verifies the pinned wgpu-native prebuilt into a cache outside any worktree.
#   gpu/native/fetch-deps.sh            download if missing, verify, print the prefix
#   gpu/native/fetch-deps.sh --offline  verify an existing cache only (no network), print the prefix
#   gpu/native/fetch-deps.sh --variant official|patched   (default $NTGPU_WGPU_VARIANT, else official)
#     official: the pinned upstream release archive (the baseline);
#     patched:  the same commit built from source with the Naga patch in compiler/ (compiler/build-patched-wgpu.sh)
# Cache root: $NT_NATIVE_GPU_DEPS (default /tmp/nt-native-gpu-deps). Nothing is installed globally.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=wgpu-native.lock
source "$HERE/wgpu-native.lock"
OFFLINE=0
VARIANT="${NTGPU_WGPU_VARIANT:-official}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline) OFFLINE=1; shift ;;
    --variant) VARIANT="${2:-}"; shift 2 ;;
    *) echo "fetch-deps: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$VARIANT" in
  official) ;;
  patched) if [[ "$OFFLINE" == 1 ]]; then exec "$HERE/compiler/build-patched-wgpu.sh" --offline; fi
           exec "$HERE/compiler/build-patched-wgpu.sh" ;;
  *) echo "fetch-deps: --variant official|patched, not '$VARIANT'" >&2; exit 2 ;;
esac
if [[ "$(uname -s)-$(uname -m)" != Darwin-arm64 ]]; then
  echo "fetch-deps: only macOS arm64 is pinned and verified; $(uname -s)-$(uname -m) is not" >&2
  exit 2
fi
DEPS="${NT_NATIVE_GPU_DEPS:-/tmp/nt-native-gpu-deps}"
PREFIX="$DEPS/wgpu-native/$WGPU_NATIVE_TAG/macos-aarch64-release"
ARCHIVE="$DEPS/downloads/$WGPU_NATIVE_TAG-$MACOS_AARCH64_ASSET"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
check() { # file expected-sha
  local got; got="$(sha "$1")"
  if [[ "$got" != "$2" ]]; then echo "fetch-deps: digest mismatch for $1: $got != $2" >&2; return 1; fi
}
verify_prefix() { # dir
  local d="$1"
  check "$d/include/webgpu/wgpu.h" "$WGPU_H_SHA256" &&
  check "$d/include/webgpu/webgpu.h" "$WEBGPU_H_SHA256" &&
  check "$d/wgpu-native-meta/webgpu.yml" "$WEBGPU_YML_SHA256" &&
  check "$d/provenance/LICENSE.APACHE" "$LICENSE_APACHE_SHA256" &&
  check "$d/provenance/LICENSE.MIT" "$LICENSE_MIT_SHA256" &&
  check "$d/provenance/LICENSE.webgpu-headers" "$WEBGPU_HEADERS_LICENSE_SHA256" &&
  check "$d/provenance/Cargo.lock" "$CARGO_LOCK_SHA256" &&
  check "$d/provenance/commit-sha" "$COMMIT_SHA_ASSET_SHA256" &&
  [[ "$(tr -d '\n' < "$d/wgpu-native-meta/wgpu-native-git-tag")" == "$WGPU_NATIVE_TAG" ]] &&
  [[ "$(tr -d '\n' < "$d/provenance/commit-sha")" == "$WGPU_NATIVE_COMMIT" ]] &&
  check "$d/lib/libwgpu_native.a" "$LIBWGPU_NATIVE_A_SHA256" &&
  check "$d/lib/libwgpu_native.dylib" "$LIBWGPU_NATIVE_DYLIB_SHA256"
}

if [[ -d "$PREFIX" ]]; then
  if verify_prefix "$PREFIX"; then printf '%s\n' "$PREFIX"; exit 0; fi
  echo "fetch-deps: cached prefix $PREFIX failed verification" >&2
  exit 1
fi
if [[ "$OFFLINE" == 1 ]]; then echo "fetch-deps: $PREFIX missing and --offline given" >&2; exit 1; fi

mkdir -p "$DEPS/downloads" "$DEPS/wgpu-native/$WGPU_NATIVE_TAG"
if [[ ! -f "$ARCHIVE" ]]; then
  curl -fsSL --retry 2 -o "$ARCHIVE.part" "$WGPU_NATIVE_RELEASE_URL/$MACOS_AARCH64_ASSET"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
check "$ARCHIVE" "$MACOS_AARCH64_SHA256"

STAGE="$(mktemp -d "$DEPS/wgpu-native/$WGPU_NATIVE_TAG/.stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
unzip -q "$ARCHIVE" -d "$STAGE"
mkdir -p "$STAGE/provenance"
RAW=https://raw.githubusercontent.com
curl -fsSL -o "$STAGE/provenance/LICENSE.APACHE" "$RAW/gfx-rs/wgpu-native/$WGPU_NATIVE_COMMIT/LICENSE.APACHE"
curl -fsSL -o "$STAGE/provenance/LICENSE.MIT" "$RAW/gfx-rs/wgpu-native/$WGPU_NATIVE_COMMIT/LICENSE.MIT"
curl -fsSL -o "$STAGE/provenance/Cargo.lock" "$RAW/gfx-rs/wgpu-native/$WGPU_NATIVE_COMMIT/Cargo.lock"
curl -fsSL -o "$STAGE/provenance/LICENSE.webgpu-headers" "$RAW/webgpu-native/webgpu-headers/$WEBGPU_HEADERS_COMMIT/LICENSE"
curl -fsSL -o "$STAGE/provenance/commit-sha" "$WGPU_NATIVE_RELEASE_URL/commit-sha"
# Upstream source equality for the headers (the archive digest alone does not prove which tree they came from).
curl -fsSL -o "$STAGE/provenance/upstream-wgpu.h" "$RAW/gfx-rs/wgpu-native/$WGPU_NATIVE_COMMIT/ffi/wgpu.h"
curl -fsSL -o "$STAGE/provenance/upstream-webgpu.h" "$RAW/webgpu-native/webgpu-headers/$WEBGPU_HEADERS_COMMIT/webgpu.h"
cmp -s "$STAGE/provenance/upstream-wgpu.h" "$STAGE/include/webgpu/wgpu.h"
cmp -s "$STAGE/provenance/upstream-webgpu.h" "$STAGE/include/webgpu/webgpu.h"
rm "$STAGE/provenance/upstream-wgpu.h" "$STAGE/provenance/upstream-webgpu.h"
cat > "$STAGE/provenance/PROVENANCE.txt" <<EOF
wgpu-native $WGPU_NATIVE_TAG (commit $WGPU_NATIVE_COMMIT, wgpu-core/naga $WGPU_CORE_VERSION)
archive  $WGPU_NATIVE_RELEASE_URL/$MACOS_AARCH64_ASSET
sha256   $MACOS_AARCH64_SHA256
headers  webgpu-native/webgpu-headers@$WEBGPU_HEADERS_COMMIT (webgpu.h), gfx-rs/wgpu-native@$WGPU_NATIVE_COMMIT (ffi/wgpu.h)
licence  wgpu-native: MIT OR Apache-2.0; webgpu-headers: BSD-3-Clause; bundled Rust crates: see Cargo.lock
         (third-party notices for the statically linked crates are not generated yet)
EOF
verify_prefix "$STAGE"
mv "$STAGE" "$PREFIX"
trap - EXIT
printf '%s\n' "$PREFIX"
