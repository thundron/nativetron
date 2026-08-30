#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
SCRIPTC="${SCRIPTC:-../../../scriptc/packages/cli/dist/main.js}"
rm -rf .scriptc
SCRIPTC_CC=zigcc SCRIPTC_TARGET=wasm32-wasi node "$SCRIPTC" build --lib --profile profile.json
echo "OK -> .scriptc/ops.wasm + ops.mjs"
