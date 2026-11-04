#!/usr/bin/env bash
# Focused scriptc reactor builds of workload.ts and both algorithm variants; writes only .scriptc/ (gitignored).
#   .scriptc/workload.wasm        profile.json: default "release" posture (-O2; wasm-opt -Oz when wasm-opt is on PATH)
#   .scriptc/speed/workload.wasm  profile-speed.json: "speed" posture (-O2, size-for-speed runtime flavor, no wasm-opt)
#   .scriptc/f32-{wide,perop}/f32-probe.wasm  f32 lowering probes
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../../../scriptc/packages/cli/dist/main.js}"
cd "$ROOT"
cmp -s <(node -e 'const p=require("./profile.json");delete p.name;console.log(JSON.stringify(p))') \
       <(node -e 'const p=require("./profile-speed.json");delete p.name;delete p.optimization;console.log(JSON.stringify(p))') \
  || { echo "profile-speed.json must equal profile.json apart from name/optimization" >&2; exit 1; }
SCRIPTC_TARGET=wasm32-wasi SCRIPTC_CC=zigcc node "$SCRIPTC" build --lib --profile profile.json
SCRIPTC_TARGET=wasm32-wasi SCRIPTC_CC=zigcc node "$SCRIPTC" build --lib --profile profile-speed.json -o .scriptc/speed/workload.wasm
# f32 lowering probes (release posture), one kernel per module: see inspect.mjs.
SCRIPTC_TARGET=wasm32-wasi SCRIPTC_CC=zigcc node "$SCRIPTC" build --lib --profile profile-f32-wide.json -o .scriptc/f32-wide/f32-probe.wasm
SCRIPTC_TARGET=wasm32-wasi SCRIPTC_CC=zigcc node "$SCRIPTC" build --lib --profile profile-f32-perop.json -o .scriptc/f32-perop/f32-probe.wasm
