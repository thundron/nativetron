#!/usr/bin/env bash
# Shows what patch 0001 changes in the Metal code: translates WGSL files to MSL with the patched naga from the build
# tree (MSL 3.2, Restrict bounds checks, loop bounding on: what wgpu-hal 29 uses on macOS 15+) and diffs each file's
# MSL against the MSL of a second copy of it, e.g. the same module with an explicit unreachable `return` added by hand.
#   gpu/native/compiler/corpus/msl-diff.sh DIR_A DIR_B   (pairs files by name; prints changed-line counts and diffs)
# The throwaway cargo project lives in the dependency cache ($NT_NATIVE_GPU_DEPS/build/msl-diff).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../wgpu-native.lock
source "$HERE/../../wgpu-native.lock"
# shellcheck source=../wgpu-native-patched.lock
source "$HERE/../wgpu-native-patched.lock"
[[ $# == 2 ]] || { echo "usage: msl-diff.sh DIR_A DIR_B" >&2; exit 2; }
DEPS="${NT_NATIVE_GPU_DEPS:-/tmp/nt-native-gpu-deps}"
"$HERE/../build-patched-wgpu.sh" --offline > /dev/null
NAGA="$DEPS/src/wgpu-native-$WGPU_NATIVE_TAG+$PATCHED_VARIANT/naga"
PROJ="$DEPS/build/msl-diff"
mkdir -p "$PROJ/src"
cat > "$PROJ/Cargo.toml" <<EOF
[package]
name = "msl-diff"
version = "0.0.0"
edition = "2021"
[dependencies]
naga = { path = "$NAGA", features = ["wgsl-in", "msl-out"] }
EOF
cat > "$PROJ/src/main.rs" <<'EOF'
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let src = std::fs::read_to_string(&path).unwrap();
    let module = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{}", e.emit_to_string(&src)));
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all())
        .validate(&module)
        .unwrap();
    let restrict = naga::proc::BoundsCheckPolicy::Restrict;
    let options = naga::back::msl::Options {
        lang_version: (3, 2),
        bounds_check_policies: naga::proc::BoundsCheckPolicies {
            index: restrict,
            buffer: restrict,
            image_load: restrict,
            binding_array: restrict,
        },
        fake_missing_bindings: true,
        ..Default::default()
    };
    let pipeline = naga::back::msl::PipelineOptions::default();
    let (msl, _) = naga::back::msl::write_string(&module, &info, &options, &pipeline).unwrap();
    print!("{msl}");
}
EOF
export CARGO_HOME="$DEPS/cargo-home" CARGO_TARGET_DIR="$PROJ/target" RUSTUP_TOOLCHAIN="${NTGPU_RUSTUP_TOOLCHAIN:-stable}"
(cd "$PROJ" && cargo build -q --offline)
for a in "$1"/*.wgsl; do
  b="$2/$(basename "$a")"
  [[ -f "$b" ]] || continue
  d="$(diff <("$PROJ/target/debug/msl-diff" "$a") <("$PROJ/target/debug/msl-diff" "$b") || true)"
  echo "$(basename "$a"): $(grep -c '^[<>]' <<< "$d" || true) diff lines"
  [[ -z "$d" ]] || sed 's/^/    /' <<< "$d"
done
