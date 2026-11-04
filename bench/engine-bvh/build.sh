#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../../../scriptc/packages/cli/dist/main.js}"
cd "$ROOT"
SCRIPTC_TARGET=wasm32-wasi SCRIPTC_CC=zigcc node "$SCRIPTC" build --lib --profile profile.json
