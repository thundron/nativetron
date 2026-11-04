#!/usr/bin/env bash
# Builds the offline Android host APK with bare SDK/NDK tools (aapt2, javac,
# d8, NDK clang, zipalign, apksigner); no build system or runtime dependencies.
#
#   hosts/android/build.sh [--debuggable]
#
# The scriptc nt-control static library is built by ipc/build-control.sh with
# SCRIPTC_TARGET=aarch64-linux-android and linked into libntcontrol.so behind
# a JNI bridge. NT_CONTROL_ARCHIVE may name an already built Android archive
# of the same profile instead. --debuggable enables the runner-only intents
# (selftest, command injection, finish) and WebView inspection; never ship it.
# Installation and launch live in hosts/android/run.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/hosts/android"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="${NT_ANDROID_BUILD_TOOLS:-$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)}"
PLATFORM="$SDK/platforms/android-35/android.jar"
NDK="${ANDROID_NDK_ROOT:-$SDK/ndk/$(ls "$SDK/ndk" | sort -V | tail -1)}"
NDK_BIN="$(echo "$NDK"/toolchains/llvm/prebuilt/*/bin)"
MIN_API=29
OUT="$ROOT/build/android"
DEBUGGABLE=0
for arg in "$@"; do
  case "$arg" in
    --debuggable) DEBUGGABLE=1 ;;
    --install) echo "build.sh no longer installs; use hosts/android/run.sh with NT_ANDROID_SERIAL" >&2; exit 2 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
for tool in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$NDK_BIN/clang" "$NDK_BIN/llvm-readelf" "$NDK_BIN/llvm-nm" "$PLATFORM"; do
  [[ -e "$tool" ]] || { echo "missing Android tool: $tool" >&2; exit 1; }
done
cd "$ROOT"

engine/build.sh --web
node ipc/generate-engine.mjs --check
node ipc/generate-control.mjs --check
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/apk/lib/arm64-v8a" "$OUT/obj"

# ── scriptc control library (aarch64-linux-android static archive) ────────
ARCHIVE="$OUT/control.lib.a"
if [[ -n "${NT_CONTROL_ARCHIVE:-}" ]]; then
  cp "$NT_CONTROL_ARCHIVE" "$ARCHIVE"
else
  SCRIPTC_CC=zigcc SCRIPTC_TARGET=aarch64-linux-android ANDROID_NDK_ROOT="$NDK" ipc/build-control.sh
  cp ipc/.scriptc/control.lib.a "$ARCHIVE"
fi
MACHINES="$("$NDK_BIN/llvm-readelf" -h "$ARCHIVE" 2>/dev/null | awk -F: '/Machine:/ { gsub(/^ +/, "", $2); print $2 }' | sort -u)"
if [[ "$MACHINES" != "AArch64" ]]; then
  echo "control archive is not an AArch64 ELF archive: $ARCHIVE" >&2; exit 1
fi
SYMBOLS="$(grep -oE 'nt_control_[a-z_]+\(' ipc/control.generated.h | tr -d '(' | sort -u)"
DEFINED="$("$NDK_BIN/llvm-nm" -g --defined-only "$ARCHIVE" 2>/dev/null | awk '$2 == "T" { print $3 }' | sort -u)"
for symbol in $SYMBOLS; do
  grep -qx "$symbol" <<<"$DEFINED" || { echo "control archive lacks $symbol from ipc/control.generated.h" >&2; exit 1; }
done

CFLAGS=(--target=aarch64-linux-android$MIN_API -std=c11 -O2 -fPIC -fvisibility=hidden -fstack-protector-strong -D_FORTIFY_SOURCE=2 -Wall -Wextra -Werror -I ipc -I "$HERE/jni")
"$NDK_BIN/clang" "${CFLAGS[@]}" -c "$HERE/jni/nt_control_host.c" -o "$OUT/obj/nt_control_host.o"
"$NDK_BIN/clang" "${CFLAGS[@]}" -c "$HERE/jni/nt_control_jni.c" -o "$OUT/obj/nt_control_jni.o"
SO="$OUT/apk/lib/arm64-v8a/libntcontrol.so"
"$NDK_BIN/clang" --target=aarch64-linux-android$MIN_API -shared -o "$SO" "$OUT/obj/nt_control_jni.o" "$OUT/obj/nt_control_host.o" "$ARCHIVE" \
  -Wl,-soname,libntcontrol.so -Wl,--version-script="$HERE/jni/exports.map" -Wl,--gc-sections -Wl,--no-undefined -Wl,--as-needed \
  -Wl,-z,max-page-size=16384 -Wl,-z,relro,-z,now -Wl,-z,noexecstack -Wl,--build-id=sha1 -lm
EXPORTS="$("$NDK_BIN/llvm-readelf" --dyn-syms "$SO" | awk '$7 != "UND" && ($5 == "GLOBAL" || $5 == "WEAK") && $4 != "NOTYPE" { print $8 }' | sort -u)"
[[ "$EXPORTS" == "JNI_OnLoad" ]] || { echo "libntcontrol.so exports more than JNI_OnLoad: $EXPORTS" >&2; exit 1; }
if "$NDK_BIN/llvm-readelf" -lW "$SO" | awk '$1 == "LOAD" && $NF != "0x4000" { bad = 1 } END { exit !bad }'; then
  echo "libntcontrol.so LOAD segments are not 16 KiB aligned" >&2; exit 1
fi

# ── offline asset bundle and generated manifest ────────────────────────────
cp -R build/engine-assets "$OUT/apk/assets"
node "$HERE/tools/bundle-manifest.mjs" "$OUT/apk/assets" "$OUT/gen/dev/nativetron/app/BundleManifest.java"

# ── manifest, Java and dex ────────────────────────────────────────────────
AAPT_FLAGS=()
[[ "$DEBUGGABLE" == 1 ]] && AAPT_FLAGS+=(--debug-mode)
"$BT/aapt2" link -I "$PLATFORM" --manifest "$HERE/AndroidManifest.xml" --min-sdk-version $MIN_API --target-sdk-version 35 \
  ${AAPT_FLAGS[@]+"${AAPT_FLAGS[@]}"} -o "$OUT/base.apk" --java "$OUT/gen"
javac -source 17 -target 17 -Xlint:all,-options,-deprecation,-restricted -Werror -cp "$PLATFORM" -d "$OUT/classes" $(find "$HERE/src" "$OUT/gen" -name '*.java')
"$BT/d8" --release --lib "$PLATFORM" --min-api $MIN_API --output "$OUT/apk" $(find "$OUT/classes" -name '*.class')

# Assets, dex and the native library are added directly so dot-directories
# (.scriptc) survive (aapt2 drops them) and wasm/.so stay uncompressed.
(cd "$OUT/apk" && zip -q -r -X -D -n .wasm:.so "$OUT/base.apk" classes.dex assets lib)

KS="${NT_ANDROID_KEYSTORE:-$HOME/.android/debug.keystore}"
if [[ ! -f "$KS" ]]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -validity 10000 >/dev/null
fi
"$BT/zipalign" -f -P 16 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/zipalign" -c -P 16 4 "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --out "$OUT/nativetron.apk" "$OUT/aligned.apk" 2>/dev/null
"$BT/apksigner" verify "$OUT/nativetron.apk" 2>/dev/null

# ── package checks ────────────────────────────────────────────────────────
APK="$OUT/nativetron.apk"
PERMISSIONS="$("$BT/aapt2" dump permissions "$APK")"
if grep -q 'uses-permission' <<<"$PERMISSIONS"; then echo "APK requests permissions: $PERMISSIONS" >&2; exit 1; fi
LISTING="$(unzip -Z "$APK" | awk 'NF >= 9 && $1 ~ /^[-d]/ { print $NF, $6 }')"
for file in $(cd "$OUT/apk" && find assets lib -type f | sort) classes.dex; do
  grep -q "^$file " <<<"$LISTING" || { echo "APK lacks $file" >&2; exit 1; }
done
for file in lib/arm64-v8a/libntcontrol.so $(cd "$OUT/apk" && find assets -name '*.wasm'); do
  grep -q "^$file stor$" <<<"$LISTING" || { echo "APK compresses $file" >&2; exit 1; }
done
DEBUG_STATE="$("$BT/aapt2" dump xmltree --file AndroidManifest.xml "$APK" | grep -c 'debuggable' || true)"
[[ "$DEBUGGABLE" == 1 && "$DEBUG_STATE" != 0 ]] || [[ "$DEBUGGABLE" == 0 && "$DEBUG_STATE" == 0 ]] || { echo "debuggable flag mismatch" >&2; exit 1; }
echo "android: $(wc -c < "$SO" | tr -d ' ') byte libntcontrol.so, $(cd "$OUT/apk" && find assets -type f | wc -l | tr -d ' ') assets, debuggable=$DEBUGGABLE"
echo "$APK"
