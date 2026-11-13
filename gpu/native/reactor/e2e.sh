#!/usr/bin/env bash
# End-to-end runs of the house-planner engine through nt-reactor against one executor, native and wasm guests, every
# flow, then image comparisons (Chrome capture of the same request, committed golden, native vs wasm) and traces.
#   gpu/native/reactor/e2e.sh --executor-lib <libntgpu-executor.dylib> [--tag real] [--root /tmp/nt-reactor-e2e]
#        [--build-dir DIR] [--engine-dylib /tmp/nt-native-reactor-1/bin/libhp-engine.dylib]
#        [--engine-wasm-dir /tmp/nt-native-reactor-1/out/wasm] [--flows triangle,golden,still,panorama,video]
#        [--guests native,wasm] [--event-order request|arrival] [-- extra nt-reactor run options]
# Needs: the sandbox (sandbox.sh) and recordings (record-app.mjs --flow <flow>) under --root. No timings are taken:
# run.json counters and timepoints.csv (raw monotonic ns) are emitted for later uncontended analysis.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/tmp/nt-reactor-e2e
TAG=
EXEC=
BUILD=
ENGINE_DYLIB=/tmp/nt-native-reactor-1/bin/libhp-engine.dylib
ENGINE_WASM=/tmp/nt-native-reactor-1/out/wasm
FLOWS=triangle,golden,still,panorama,video
GUESTS=native,wasm
ORDER=request
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --executor-lib) EXEC="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --build-dir) BUILD="$2"; shift 2 ;;
    --engine-dylib) ENGINE_DYLIB="$2"; shift 2 ;;
    --engine-wasm-dir) ENGINE_WASM="$2"; shift 2 ;;
    --flows) FLOWS="$2"; shift 2 ;;
    --guests) GUESTS="$2"; shift 2 ;;
    --event-order) ORDER="$2"; shift 2 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) echo "e2e: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ -n "$EXEC" ]] || { echo "e2e: --executor-lib is required" >&2; exit 2; }
BUILD="${BUILD:-$ROOT/build}"
TAG="${TAG:-$(basename "$EXEC" .dylib)}"
[[ -x "$BUILD/nt-reactor" ]] || "$HERE/build.sh" --out "$BUILD" >/dev/null
OUT="$ROOT/runs/$TAG"
mkdir -p "$OUT" "$ROOT/scenarios"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"
say() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
say "executor $EXEC ($(shasum -a 256 "$EXEC" | cut -c1-16)) engine dylib $(shasum -a 256 "$ENGINE_DYLIB" | cut -c1-16) wasm $(shasum -a 256 "$ENGINE_WASM/hp-engine.wasm" | cut -c1-16)"
say "flags: event order $ORDER, ${EXTRA[*]:-no extra options}"
IFS=, read -r -a flows <<< "$FLOWS"
IFS=, read -r -a guests <<< "$GUESTS"
for flow in "${flows[@]}"; do
  SC="$ROOT/scenarios/$flow"
  REC="$ROOT/recordings/bresso-living-$flow"
  W=960 H=600
  if [[ "$flow" == triangle ]]; then
    node "$HERE/scenario.mjs" triangle "$SC" --hp "$ROOT/hp" >/dev/null; W=640 H=400
  else
    [[ -f "$REC/recording.json" ]] || { say "$flow: SKIPPED (no recording at $REC)"; continue; }
    probe=(); [[ "$flow" == golden ]] && probe=(--codec-probe)
    node "$HERE/scenario.mjs" app "$SC" --recording "$REC/recording.json" --hp "$ROOT/hp" ${probe[@]+"${probe[@]}"} >/dev/null
  fi
  runs=()
  for guest in "${guests[@]}"; do
    case "$guest" in
      native) spec="native:$ENGINE_DYLIB" ;;
      native-process) spec="native-process:$ENGINE_DYLIB" ;;
      wasm) spec="wasm:$ENGINE_WASM" ;;
      *) say "unknown guest $guest"; continue ;;
    esac
    dir="$OUT/$flow-$guest"
    rm -rf "$dir"
    "$BUILD/nt-reactor" run --engine "$spec" --executor-lib "$EXEC" --width $W --height $H --event-order "$ORDER" \
      --script "$SC/script.txt" --out "$dir" --trace "$dir/trace.txt" ${EXTRA[@]+"${EXTRA[@]}"} > "$dir.log" 2>&1
    rc=$?
    say "$flow/$guest: exit $rc ($(tail -1 "$dir.log"))"
    runs+=("$dir")
  done
  if [[ ${#runs[@]} -ge 2 ]]; then
    if cmp -s "${runs[0]}/trace.txt" "${runs[1]}/trace.txt"; then say "$flow: traces ${runs[0]##*/} vs ${runs[1]##*/} BYTE-IDENTICAL"
    else say "$flow: traces differ (first difference: line $(cmp "${runs[0]}/trace.txt" "${runs[1]}/trace.txt" 2>/dev/null | sed -n 's/.*line \([0-9]*\).*/\1/p'))"; fi
  fi
  refs=()
  if [[ -f "$REC/recording.json" && "$flow" != triangle ]]; then
    while IFS= read -r line; do refs+=($line); done < <(node -e '
      const r = require(process.argv[1]); for (const c of r.chromeCaptures) if (c.png) console.log(`--chrome chrome-${c.rid}=${process.argv[2]}/${c.png}`);
      if (r.flow === "golden") for (const c of r.chromeCaptures) console.log(`--golden chrome-${c.rid}=${process.argv[3]}/test/golden/engine/bresso-${r.view}.png`);' "$REC/recording.json" "$REC" "$ROOT/hp")
  fi
  node "$HERE/post.mjs" "${runs[@]}" ${refs[@]+"${refs[@]}"} --hp "$ROOT/hp" --out "$OUT/$flow-report.json" 2>&1 | tee -a "$SUMMARY"
  if [[ "$flow" == panorama ]]; then
    for d in "${runs[@]}"; do [[ -f "$d/run.json" ]] && node "$HERE/panorama.mjs" "$d" "$REC" --hp "$ROOT/hp" 2>&1 | sed "s|^|${d##*/}: |" | tee -a "$SUMMARY"; done
  fi
done
say "summary: $SUMMARY"
