#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../../scriptc/packages/cli/dist/main.js}"
node "$ROOT/generate.mjs" --check
cd "$ROOT"
SCRIPTC_TARGET=wasm32-wasi SCRIPTC_CC=zigcc node "$SCRIPTC" build --lib --profile profile.json
SCRIPTC_TARGET=wasm32-wasi SCRIPTC_CC=zigcc node "$SCRIPTC" build --lib --profile conformance-profile.json
