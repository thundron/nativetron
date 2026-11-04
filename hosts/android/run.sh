#!/usr/bin/env bash
# Device acceptance runner for the Android host. Never starts an emulator and
# never picks a device implicitly: NT_ANDROID_SERIAL must name an attached
# arm64 device. Requires an APK from `hosts/android/build.sh --debuggable`.
#
#   NT_ANDROID_SERIAL=<serial> hosts/android/run.sh
#
# Phases: install, cold selftest (engine readback → native menu command sent
# through the scriptc control library → GPU_COLOUR_CHANGED), background/resume,
# runner-injected native command, disposal, and relaunch in the same process
# (library reopen). logcat is collected to build/android/run/logcat.txt.
# Exit: 0 pass, 3 host/control pass but WebGPU unavailable on the device, 1 fail.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="${NT_ANDROID_BUILD_TOOLS:-$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)}"
ADB="$SDK/platform-tools/adb"
APK="${NT_ANDROID_APK:-$ROOT/build/android/nativetron.apk}"
PACKAGE=dev.nativetron.app
ACTIVITY=$PACKAGE/.MainActivity
OUT="$ROOT/build/android/run"
LOG="$OUT/logcat.txt"
TIMEOUT="${NT_ANDROID_TIMEOUT:-45}"

SERIAL="${NT_ANDROID_SERIAL:-}"
[[ -n "$SERIAL" ]] || { echo "set NT_ANDROID_SERIAL to an attached device (see: adb devices -l); no device is chosen implicitly" >&2; exit 2; }
[[ -f "$APK" ]] || { echo "missing $APK; run hosts/android/build.sh --debuggable" >&2; exit 2; }
"$BT/aapt2" dump badging "$APK" 2>/dev/null | grep -q '^application-debuggable' || { echo "$APK is not debuggable; runner intents are disabled in it" >&2; exit 2; }
adb() { "$ADB" -s "$SERIAL" "$@"; }
[[ "$(adb get-state 2>/dev/null || true)" == device ]] || { echo "device $SERIAL is not online" >&2; exit 2; }
[[ "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" != 1 ]] || [[ "${NT_ANDROID_ALLOW_EMULATOR:-}" == 1 ]] || { echo "$SERIAL is an emulator; set NT_ANDROID_ALLOW_EMULATOR=1 to accept it" >&2; exit 2; }
adb shell getprop ro.product.cpu.abilist | grep -q arm64-v8a || { echo "$SERIAL has no arm64-v8a ABI" >&2; exit 2; }

mkdir -p "$OUT"
: > "$LOG"
LOGCAT_PID=
cleanup() { [[ -n "$LOGCAT_PID" ]] && kill "$LOGCAT_PID" 2>/dev/null || true; }
trap cleanup EXIT

{
  echo "device $SERIAL $(adb shell getprop ro.product.model | tr -d '\r') sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
  echo "webview $(adb shell dumpsys webviewupdate 2>/dev/null | grep -m1 'Current WebView package' | tr -d '\r' || true)"
  echo "apk $(shasum -a 256 "$APK" | cut -d' ' -f1)"
} > "$OUT/device.txt"
cat "$OUT/device.txt"

[[ "${NT_ANDROID_SKIP_INSTALL:-}" == 1 ]] || adb install -r "$APK" >/dev/null
adb shell am force-stop "$PACKAGE"
adb logcat -c
adb logcat -v threadtime nt-android:V nt-control:V nt-engine:V nt-console:V nt-offline:V AndroidRuntime:E DEBUG:V libc:F '*:S' > "$LOG" 2>&1 &
LOGCAT_PID=$!

count() { grep -c -E "$1" "$LOG" || true; }
# wait_for <extended regex> <minimum count> → 0 when seen, 1 on timeout or crash.
wait_for() {
  local deadline=$((SECONDS + TIMEOUT))
  while (( SECONDS < deadline )); do
    (( $(count "$1") >= $2 )) && return 0
    (( $(count 'FATAL EXCEPTION|Fatal signal|NT_CONTROL_PANIC|NT_ANDROID_ASSET_FAIL') == 0 )) || return 1
    sleep 0.5
  done
  return 1
}
fail() { echo "FAIL: $*" | tee -a "$OUT/summary.txt"; exit 1; }
: > "$OUT/summary.txt"
TERMINAL='NT_ANDROID_(OK|UNAVAILABLE|TIMEOUT|CONTROL_FAILED|RENDERER_FAILED|GPU_FAILED)'

# 1. cold launch selftest
adb shell am start -W -n "$ACTIVITY" --ez nt.selftest true >/dev/null
wait_for 'NT_CONTROL_READY' 1 || fail "scriptc control library did not open"
wait_for "$TERMINAL" 1 || fail "no selftest terminal marker"
RESULT="$(grep -oE "$TERMINAL.*" "$LOG" | head -1 | tr -d '\r')"
echo "selftest: $RESULT" | tee -a "$OUT/summary.txt"
case "$RESULT" in NT_ANDROID_OK*) GPU=1 ;; NT_ANDROID_UNAVAILABLE*) GPU=0 ;; *) fail "$RESULT" ;; esac
(( $(count 'NT_ANDROID_COMMAND_SENT 1') >= GPU )) || fail "native command frame never reached the page"

wait_for 'NT_ANDROID_ASSET_OK' 1 || fail "real WebView asset/MIME/offline probe failed"
echo "assets: MIME, isolation headers and offline refusals verified" | tee -a "$OUT/summary.txt"

# 2. background and resume
adb shell input keyevent KEYCODE_HOME
wait_for 'NT_LIFECYCLE stop' 1 || fail "activity did not stop in background"
adb shell am start -W -n "$ACTIVITY" >/dev/null
wait_for 'NT_LIFECYCLE resume' 2 || fail "activity did not resume"
echo "lifecycle: background/resume ok" | tee -a "$OUT/summary.txt"

# 3. runner-injected command through the scriptc library after resume
SENT=$(count 'NT_ANDROID_COMMAND_SENT 1')
CHANGED=$(count 'nt-engine.*GPU_COLOUR_CHANGED')
adb shell am start -n "$ACTIVITY" --ei nt.command 1 >/dev/null
wait_for 'NT_ANDROID_COMMAND_SENT 1' $((SENT + 1)) || fail "resumed native command not delivered"
if (( GPU )); then wait_for 'nt-engine.*GPU_COLOUR_CHANGED' $((CHANGED + 1)) || fail "engine did not apply resumed command"; fi
echo "command after resume: ok" | tee -a "$OUT/summary.txt"

# 4. disposal
adb shell am start -n "$ACTIVITY" --ez nt.finish true >/dev/null
wait_for 'NT_ANDROID_DISPOSED' 1 || fail "activity was not disposed"
wait_for 'NT_CONTROL_CLOSED 0' 1 || fail "control library was not released on its owner thread"
echo "disposal: ok" | tee -a "$OUT/summary.txt"

# 5. relaunch: a new owner thread reopens the library (same process when it survived)
adb shell am start -W -n "$ACTIVITY" --ez nt.selftest true >/dev/null
wait_for 'NT_CONTROL_READY' 2 || fail "control library did not reopen"
wait_for "$TERMINAL" 2 || fail "no relaunch selftest marker"
SECOND="$(grep -oE "$TERMINAL.*" "$LOG" | sed -n 2p | tr -d '\r')"
echo "relaunch: $SECOND" | tee -a "$OUT/summary.txt"
[[ "$SECOND" == "${RESULT%% *}"* ]] || fail "relaunch result differs: $SECOND"
wait_for 'NT_ANDROID_ASSET_OK' 2 || fail "relaunch asset probe did not pass"
adb shell am start -n "$ACTIVITY" --ez nt.finish true >/dev/null
wait_for 'NT_ANDROID_DISPOSED' 2 || fail "relaunched activity was not disposed"

echo "offline: $(count 'REQUEST_BLOCKED') blocked, $(count 'REQUEST_REFUSED') refused, $(count 'NAVIGATION_BLOCKED') navigations blocked" | tee -a "$OUT/summary.txt"
(( $(count 'FATAL EXCEPTION|Fatal signal') == 0 )) || fail "crash in log"
if (( GPU )); then echo "PASS" | tee -a "$OUT/summary.txt"; exit 0; fi
echo "PASS_HOST_ONLY (WebGPU unavailable on device)" | tee -a "$OUT/summary.txt"
exit 3
