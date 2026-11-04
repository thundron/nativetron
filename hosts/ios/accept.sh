#!/usr/bin/env bash
# iOS runtime acceptance runner with evidence collection.
#   hosts/ios/accept.sh sim      iOS 18.6 simulator (NT_IOS_SIMULATOR selects one)
#   hosts/ios/accept.sh device   physical device; requires NT_IOS_TEAM and NT_IOS_DEVICE
# Evidence: build/ios-evidence/<UTC>-<mode>/ (metadata, raw console/log captures, summary.json).
# Exit 0 pass, 3 control path verified but GPU unavailable, 1 failure. NT_IOS_SKIP_BUILD=1 reuses
# the last build; NT_IOS_ACCEPT_TIMEOUT (default 150 s) bounds the in-app sequence.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MODE="${1:-}"
case "$MODE" in sim|device) ;; *) echo 'usage: accept.sh sim|device' >&2; exit 2;; esac
source "$HERE/signing-policy.sh"
nt_ios_check_team "$([[ "$MODE" == device ]] && echo device-accept || echo sim)"
BUNDLE=dev.nativetron.gpu
TIMEOUT="${NT_IOS_ACCEPT_TIMEOUT:-150}"
EVIDENCE="$ROOT/build/ios-evidence/$(date -u +%Y%m%dT%H%M%SZ)-$MODE"
mkdir -p "$EVIDENCE"
PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_for() { # wait_for <pattern> <seconds>
  local deadline=$((SECONDS + $2))
  while (( SECONDS < deadline )); do
    if grep -qh -- "$1" "$EVIDENCE"/*.txt 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

metadata() {
  python3 - "$EVIDENCE/metadata.json" "$@" <<'PY'
import json, sys
out, *pairs = sys.argv[1:]
data = dict(pair.split("=", 1) for pair in pairs)
json.dump(data, open(out, "w"), indent=2, sort_keys=True)
PY
}

if [[ "$MODE" == sim ]]; then
  [[ "${NT_IOS_SKIP_BUILD:-0}" == 1 ]] || "$HERE/build.sh" sim-build
  APP="$ROOT/build/ios-iphonesimulator/Build/Products/Debug-iphonesimulator/Nativetron.app"
  CONTROL="$ROOT/build/ios-control/iphonesimulator/archive.json"
  SIM="$("$HERE/select-simulator.sh")"
  RUNTIME="$(xcrun simctl list devices -j | python3 -c 'import json,sys; u=sys.argv[1]; print(next((k+" "+x["name"] for k,v in json.load(sys.stdin)["devices"].items() for x in v if x["udid"]==u), ""))' "$SIM")"
  metadata mode=sim simulator="$SIM" runtime="$RUNTIME" macos="$(sw_vers -productVersion)" xcode="$(xcodebuild -version | tr '\n' ' ')" \
    head="$(git -C "$ROOT" rev-parse HEAD)" control="$(cat "$CONTROL" 2>/dev/null | tr -d '\n' || echo missing)"
  touch "$EVIDENCE/lifecycle.required"
  xcrun simctl boot "$SIM" 2>/dev/null || true
  xcrun simctl bootstatus "$SIM" -b >/dev/null
  xcrun simctl install "$SIM" "$APP"
  xcrun simctl spawn "$SIM" log stream --style compact --level info --predicate 'subsystem == "dev.nativetron.gpu"' >"$EVIDENCE/unified-log.txt" 2>&1 &
  PIDS+=($!)
  sleep 2
  xcrun simctl terminate "$SIM" "$BUNDLE" 2>/dev/null || true
  xcrun simctl launch --console-pty --terminate-running-process "$SIM" "$BUNDLE" --nt-acceptance >"$EVIDENCE/console.txt" 2>&1 &
  PIDS+=($!)
  wait_for NT_IOS_ACCEPT_DONE "$TIMEOUT" || echo "ios accept: NT_IOS_ACCEPT_DONE not observed within ${TIMEOUT}s" | tee "$EVIDENCE/runner.txt"
  # Lifecycle: background by foregrounding Settings, then bring the host back.
  xcrun simctl launch "$SIM" com.apple.Preferences >/dev/null 2>&1 || true
  wait_for 'NT_IOS_LIFECYCLE background' 15 || echo 'ios accept: background transition not observed' >>"$EVIDENCE/runner.txt"
  xcrun simctl launch "$SIM" "$BUNDLE" >/dev/null 2>&1 || true
  wait_for 'NT_IOS_LIFECYCLE foreground' 15 || echo 'ios accept: foreground transition not observed' >>"$EVIDENCE/runner.txt"
  sleep 2
  xcrun simctl terminate "$SIM" "$BUNDLE" 2>/dev/null || true
  sleep 1
else
  : "${NT_IOS_DEVICE:?set NT_IOS_DEVICE to the physical device identifier}"
  [[ "${NT_IOS_SKIP_BUILD:-0}" == 1 ]] || "$HERE/build.sh" device-build
  APP="$ROOT/build/ios-iphoneos/Build/Products/Debug-iphoneos/Nativetron.app"
  nt_ios_verify_signature "$APP" | tee "$EVIDENCE/signature.txt"
  CONTROL="$ROOT/build/ios-control/iphoneos/archive.json"
  xcrun devicectl device info details --device "$NT_IOS_DEVICE" >"$EVIDENCE/device.log" 2>&1 || true
  metadata mode=device device="$NT_IOS_DEVICE" team="$NT_IOS_TEAM" macos="$(sw_vers -productVersion)" xcode="$(xcodebuild -version | tr '\n' ' ')" \
    head="$(git -C "$ROOT" rev-parse HEAD)" control="$(cat "$CONTROL" 2>/dev/null | tr -d '\n' || echo missing)"
  xcrun devicectl device install app --device "$NT_IOS_DEVICE" "$APP"
  xcrun devicectl device process launch --device "$NT_IOS_DEVICE" --console --terminate-existing -- "$BUNDLE" --nt-acceptance >"$EVIDENCE/console.txt" 2>&1 &
  PIDS+=($!)
  wait_for NT_IOS_ACCEPT_DONE "$TIMEOUT" || echo "ios accept: NT_IOS_ACCEPT_DONE not observed within ${TIMEOUT}s" | tee "$EVIDENCE/runner.txt"
  echo 'ios accept: device lifecycle transitions are not automated; background/foreground manually while capturing if required' >>"$EVIDENCE/runner.txt"
  sleep 2
fi
cleanup
PIDS=()
set +e
python3 "$HERE/summarize-evidence.py" "$EVIDENCE"
STATUS=$?
set -e
echo "ios accept: evidence in $EVIDENCE"
exit "$STATUS"
