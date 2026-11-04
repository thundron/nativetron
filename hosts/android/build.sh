#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
PLATFORM="$SDK/platforms/android-35/android.jar"
OUT="$ROOT/build/android"
cd "$ROOT"
engine/build.sh --web
node ipc/generate-engine.mjs --check
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes"
"$BT/aapt2" link -I "$PLATFORM" --manifest hosts/android/AndroidManifest.xml -o "$OUT/base.apk" -A build/engine-assets --java "$OUT/gen" -0 wasm
javac -source 17 -target 17 -nowarn -Xlint:-options -cp "$PLATFORM" -d "$OUT/classes" $(find hosts/android/src "$OUT/gen" -name '*.java')
"$BT/d8" --lib "$PLATFORM" --min-api 29 --output "$OUT" $(find "$OUT/classes" -name '*.class')
(cd "$OUT" && zip -q base.apk classes.dex)
KS="${NT_ANDROID_KEYSTORE:-$HOME/.android/debug.keystore}"
if [[ ! -f "$KS" ]]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -validity 10000 >/dev/null
fi
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --out "$OUT/nativetron.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/nativetron.apk"
echo "$OUT/nativetron.apk"
if [[ "${1:-}" == --install ]]; then
  "$SDK/platform-tools/adb" install -r "$OUT/nativetron.apk"
  "$SDK/platform-tools/adb" shell am start -n dev.nativetron.app/.MainActivity
fi
