#!/usr/bin/env bash
# Builds the pinned wgpu-native commit from source with the Naga patches in patches/ and installs it as a
# prefix with the same layout as the official prebuilt one. Everything lives in the dependency cache, never in a
# worktree; nothing is installed globally (CARGO_HOME is inside the cache; the rustup toolchain is only used).
#   gpu/native/compiler/build-patched-wgpu.sh            build if missing, verify, print the prefix
#   gpu/native/compiler/build-patched-wgpu.sh --offline  never touch the network (verify, or build from the cache)
#   gpu/native/compiler/build-patched-wgpu.sh --rebuild  discard the installed prefix and build again
# Cache ($NT_NATIVE_GPU_DEPS, default /tmp/nt-native-gpu-deps):
#   src/wgpu-native-<commit12>/                 pristine checkout of the pinned commit (+ webgpu-headers submodule)
#   src/wgpu-native-<tag>+<variant>/            build tree: checkout copy, patched naga/ crate, Cargo.lock naming it
#   cargo-home/                                 crates.io downloads (Cargo.lock checksums)
#   build/cargo-target-<tag>+<variant>/         cargo target dir (delete freely; only the prefix is used)
#   wgpu-native/<tag>+<variant>/macos-aarch64-release/{include,lib,wgpu-native-meta,provenance}
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/.." && pwd)"
# shellcheck source=../wgpu-native.lock
source "$NATIVE/wgpu-native.lock"
# shellcheck source=wgpu-native-patched.lock
source "$HERE/wgpu-native-patched.lock"
OFFLINE=0
REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    --rebuild) REBUILD=1 ;;
    *) echo "build-patched-wgpu: unknown argument $arg" >&2; exit 2 ;;
  esac
done
if [[ "$(uname -s)-$(uname -m)" != Darwin-arm64 ]]; then
  echo "build-patched-wgpu: only macOS arm64 is pinned and verified" >&2
  exit 2
fi
DEPS="${NT_NATIVE_GPU_DEPS:-/tmp/nt-native-gpu-deps}"
TAGV="$WGPU_NATIVE_TAG+$PATCHED_VARIANT"
PREFIX="$DEPS/wgpu-native/$TAGV/macos-aarch64-release"
CHECKOUT="$DEPS/src/wgpu-native-${WGPU_NATIVE_COMMIT:0:12}"
TREE="$DEPS/src/wgpu-native-$TAGV"
TARGET_DIR="${NTGPU_PATCHED_TARGET_DIR:-$DEPS/build/cargo-target-$TAGV}"
export CARGO_HOME="$DEPS/cargo-home"
# rust-toolchain.toml names 1.93, which is not installed; an override keeps rustup from installing anything.
export RUSTUP_TOOLCHAIN="${NTGPU_RUSTUP_TOOLCHAIN:-stable}"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
check() { # file expected-sha
  local got; got="$(sha "$1")"
  if [[ "$got" != "$2" ]]; then echo "build-patched-wgpu: digest mismatch for $1: $got != $2" >&2; return 1; fi
}
PATCH_FILES=()
while read -r file digest; do
  [[ -n "$file" ]] || continue
  check "$HERE/$file" "$digest" || { echo "build-patched-wgpu: update wgpu-native-patched.lock" >&2; exit 1; }
  PATCH_FILES+=("$HERE/$file")
done <<< "$NAGA_PATCHES"
pinned_toolchain() { [[ "$(rustc --version)" == "$RUSTC_VERSION" ]]; }

verify_prefix() { # dir
  local d="$1"
  [[ -f "$d/provenance/SHA256SUMS" ]] || { echo "build-patched-wgpu: $d has no SHA256SUMS" >&2; return 1; }
  (cd "$d" && shasum -a 256 -c --quiet provenance/SHA256SUMS) || return 1
  check "$d/include/webgpu/wgpu.h" "$WGPU_H_SHA256" &&
  check "$d/include/webgpu/webgpu.h" "$WEBGPU_H_SHA256" &&
  check "$d/wgpu-native-meta/webgpu.yml" "$WEBGPU_YML_SHA256" &&
  (cd "$d/provenance/naga-patches" && while read -r file digest; do
     [[ -z "$file" ]] || check "$(basename "$file")" "$digest" || exit 1; done <<< "$NAGA_PATCHES") &&
  [[ "$(tr -d '\n' < "$d/wgpu-native-meta/wgpu-native-git-tag")" == "$TAGV" ]] || return 1
  if [[ "$(cat "$d/provenance/rustc-version")" == "$RUSTC_VERSION" ]]; then
    check "$d/lib/libwgpu_native.a" "$PATCHED_LIBWGPU_NATIVE_A_SHA256" &&
    check "$d/lib/libwgpu_native.dylib" "$PATCHED_LIBWGPU_NATIVE_DYLIB_SHA256" || return 1
  elif [[ "${NTGPU_RUSTC_ANY:-0}" != 1 ]]; then
    echo "build-patched-wgpu: $d was built by $(cat "$d/provenance/rustc-version"), not $RUSTC_VERSION" >&2
    return 1
  fi
}

if [[ "$REBUILD" == 1 ]]; then rm -rf "$PREFIX"; fi
if [[ -d "$PREFIX" ]]; then
  if verify_prefix "$PREFIX"; then printf '%s\n' "$PREFIX"; exit 0; fi
  echo "build-patched-wgpu: cached prefix $PREFIX failed verification (--rebuild replaces it)" >&2
  exit 1
fi

if ! pinned_toolchain && [[ "${NTGPU_RUSTC_ANY:-0}" != 1 ]]; then
  echo "build-patched-wgpu: need $RUSTC_VERSION (RUSTUP_TOOLCHAIN=$RUSTUP_TOOLCHAIN gives $(rustc --version));" \
       "set NTGPU_RUSTUP_TOOLCHAIN, or NTGPU_RUSTC_ANY=1 to build without the pinned output digests" >&2
  exit 1
fi

# The official prebuilt stays the verified baseline; its licence files and provenance are reused.
OFFLINE_ARG=()
[[ "$OFFLINE" == 0 ]] || OFFLINE_ARG=(--offline)
OFFICIAL="$("$NATIVE/fetch-deps.sh" --variant official ${OFFLINE_ARG[@]+"${OFFLINE_ARG[@]}"})"

# 1. Pristine source at the pinned commit (the release was built from it), checked against the pinned digests.
if [[ ! -d "$CHECKOUT/.git" ]]; then
  [[ "$OFFLINE" == 0 ]] || { echo "build-patched-wgpu: $CHECKOUT missing and --offline given" >&2; exit 1; }
  rm -rf "$CHECKOUT.part"
  git -c init.defaultBranch=main init -q "$CHECKOUT.part"
  git -C "$CHECKOUT.part" remote add origin https://github.com/gfx-rs/wgpu-native.git
  git -C "$CHECKOUT.part" fetch -q --depth 1 origin "$WGPU_NATIVE_COMMIT"
  git -C "$CHECKOUT.part" -c advice.detachedHead=false checkout -q FETCH_HEAD
  git -C "$CHECKOUT.part" submodule update -q --init --depth 1 ffi/webgpu-headers
  mv "$CHECKOUT.part" "$CHECKOUT"
fi
[[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$WGPU_NATIVE_COMMIT" ]]
[[ "$(git -C "$CHECKOUT/ffi/webgpu-headers" rev-parse HEAD)" == "$WEBGPU_HEADERS_COMMIT" ]]
[[ -z "$(git -C "$CHECKOUT" status --porcelain)" ]] || { echo "build-patched-wgpu: $CHECKOUT is modified" >&2; exit 1; }
check "$CHECKOUT/Cargo.lock" "$CARGO_LOCK_SHA256"
check "$CHECKOUT/ffi/wgpu.h" "$WGPU_H_SHA256"
check "$CHECKOUT/ffi/webgpu-headers/webgpu.h" "$WEBGPU_H_SHA256"
check "$CHECKOUT/ffi/webgpu-headers/webgpu.yml" "$WEBGPU_YML_SHA256"

# 2. Crates exactly as locked (cargo checks every .crate against the Cargo.lock checksum).
if [[ "$OFFLINE" == 1 ]]; then
  (cd "$CHECKOUT" && cargo fetch --locked --offline -q)
else
  (cd "$CHECKOUT" && cargo fetch --locked -q)
fi
NAGA_CRATE="$(find "$CARGO_HOME/registry/cache" -name "naga-$NAGA_VERSION.crate" | head -1)"
check "$NAGA_CRATE" "$NAGA_CRATE_SHA256"
grep -A3 '^name = "naga"$' "$CHECKOUT/Cargo.lock" | grep -qx "checksum = \"$NAGA_CRATE_SHA256\""

# 3. Build tree: the checkout, the patched naga crate, and a Cargo.lock in which only naga's source changes.
rm -rf "$TREE"
mkdir -p "$TREE"
(cd "$CHECKOUT" && tar --exclude .git -cf - .) | (cd "$TREE" && tar -xf -)
mkdir -p "$TREE/naga"
tar -xzf "$NAGA_CRATE" -C "$TREE/naga" --strip-components 1
for p in "${PATCH_FILES[@]}"; do (cd "$TREE/naga" && patch -p1 -s -N < "$p"); done
mkdir -p "$TREE/.cargo"
cat > "$TREE/.cargo/config.toml" <<EOF
# naga $NAGA_VERSION (crates.io checksum $NAGA_CRATE_SHA256) with gpu/native/compiler/patches applied.
[patch.crates-io]
naga = { path = "naga" }
EOF
# A path dependency has no source/checksum line; nothing else in the lock changes.
awk '
  /^\[\[package\]\]$/ { innaga = 0 }
  $0 == "name = \"naga\"" { innaga = 1 }
  innaga && (/^source = / || /^checksum = /) { next }
  { print }
' "$CHECKOUT/Cargo.lock" > "$TREE/Cargo.lock"
DIFF_LINES="$(diff "$CHECKOUT/Cargo.lock" "$TREE/Cargo.lock" | grep -c '^<' || true)"
[[ "$DIFF_LINES" == 2 ]] || { echo "build-patched-wgpu: unexpected Cargo.lock edit ($DIFF_LINES lines)" >&2; exit 1; }

# 4. Release build with upstream's macOS release environment. Paths are remapped so neither the cache location nor
#    the home directory leaks into (or changes) the libraries.
export MACOSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET_PIN"
export WGPU_NATIVE_VERSION="$WGPU_NATIVE_TAG"
# With the rust-src component installed, std paths would otherwise resolve into the local rustup directory.
RUST_SRC="$(rustc --print sysroot)/lib/rustlib/src/rust"
RUSTC_COMMIT="$(rustc -vV | sed -n 's/^commit-hash: //p')"
export RUSTFLAGS="-C link-args=-Wl,-install_name,@rpath/libwgpu_native.dylib \
--remap-path-prefix=$CARGO_HOME=/cargo --remap-path-prefix=$TREE=/wgpu-native \
--remap-path-prefix=$RUST_SRC=/rustc/$RUSTC_COMMIT"
export CARGO_TARGET_DIR="$TARGET_DIR"
(cd "$TREE" && cargo build --release --locked --offline -q)

# 5. Install a prefix laid out like the official archive, plus provenance and a digest list for re-verification.
STAGE="$(mktemp -d "$DEPS/wgpu-native/.stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/include/webgpu" "$STAGE/lib" "$STAGE/wgpu-native-meta" "$STAGE/provenance"
cp "$TREE/ffi/webgpu-headers/webgpu.h" "$TREE/ffi/wgpu.h" "$STAGE/include/webgpu/"
cp "$TREE/ffi/webgpu-headers/webgpu.yml" "$STAGE/wgpu-native-meta/"
printf '%s\n' "$TAGV" > "$STAGE/wgpu-native-meta/wgpu-native-git-tag"
cp "$TARGET_DIR/release/libwgpu_native.a" "$TARGET_DIR/release/libwgpu_native.dylib" "$STAGE/lib/"
cp "$OFFICIAL/provenance/LICENSE.APACHE" "$OFFICIAL/provenance/LICENSE.MIT" "$OFFICIAL/provenance/LICENSE.webgpu-headers" \
   "$OFFICIAL/provenance/commit-sha" "$STAGE/provenance/"
cp "$TREE/naga/LICENSE.APACHE" "$STAGE/provenance/LICENSE.naga.APACHE"
cp "$TREE/naga/LICENSE.MIT" "$STAGE/provenance/LICENSE.naga.MIT"
cp "$TREE/Cargo.lock" "$STAGE/provenance/Cargo.lock"
diff -u --label upstream/Cargo.lock --label patched/Cargo.lock "$CHECKOUT/Cargo.lock" "$TREE/Cargo.lock" > "$STAGE/provenance/Cargo.lock.diff" || true
mkdir -p "$STAGE/provenance/naga-patches"
cp "${PATCH_FILES[@]}" "$STAGE/provenance/naga-patches/"
rustc --version > "$STAGE/provenance/rustc-version"
{
  rustc -vV; cargo -V
  echo "ld: $(xcrun ld -v 2>&1 | head -1)"
  echo "clang: $(xcrun clang --version | head -1)"
  echo "sdk: $(xcrun --show-sdk-version)"
  echo "MACOSX_DEPLOYMENT_TARGET=$MACOSX_DEPLOYMENT_TARGET"
  echo "WGPU_NATIVE_VERSION=$WGPU_NATIVE_VERSION"
  echo "RUSTFLAGS=-C link-args=-Wl,-install_name,@rpath/libwgpu_native.dylib --remap-path-prefix=<cargo-home>=/cargo" \
       "--remap-path-prefix=<tree>=/wgpu-native --remap-path-prefix=<sysroot>/lib/rustlib/src/rust=/rustc/<commit-hash>"
  echo "command: cargo build --release --locked --offline"
} > "$STAGE/provenance/BUILD-INFO.txt"
cat > "$STAGE/provenance/PROVENANCE.txt" <<EOF
wgpu-native $WGPU_NATIVE_TAG (commit $WGPU_NATIVE_COMMIT) built from source, variant $PATCHED_VARIANT
naga        $NAGA_VERSION from crates.io (sha256 $NAGA_CRATE_SHA256; src identical to gfx-rs/wgpu@$NAGA_GIT_COMMIT naga/src)
            + naga-patches/0001 (WGSL §9.7 behavior analysis for function ends, gfx-rs/wgpu#9501)
            + naga-patches/0002 (let-bound values stay runtime after override substitution, gfx-rs/wgpu#9002)
            digests in SHA256SUMS; rationale in nativetron gpu/native/compiler/README.md
lock        Cargo.lock = upstream Cargo.lock (sha256 $CARGO_LOCK_SHA256) with naga's source/checksum removed
            (Cargo.lock.diff); every other crate is the locked crates.io release
headers     webgpu-native/webgpu-headers@$WEBGPU_HEADERS_COMMIT (webgpu.h), gfx-rs/wgpu-native@$WGPU_NATIVE_COMMIT (ffi/wgpu.h)
licence     wgpu-native and naga: MIT OR Apache-2.0; webgpu-headers: BSD-3-Clause; bundled Rust crates: see Cargo.lock
            (third-party notices for the statically linked crates are not generated yet)
toolchain   see BUILD-INFO.txt
EOF
(cd "$STAGE" && find include lib wgpu-native-meta provenance -type f ! -name SHA256SUMS | LC_ALL=C sort |
  xargs shasum -a 256 > provenance/SHA256SUMS)
mkdir -p "$(dirname "$PREFIX")"
verify_prefix "$STAGE" || { echo "build-patched-wgpu: the new build failed verification (see digests above)" >&2; exit 1; }
mv "$STAGE" "$PREFIX"
trap - EXIT
printf '%s\n' "$PREFIX"
