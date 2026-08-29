#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../../scriptc/packages/cli/dist/main.js}"
for d in "$ROOT/web-runtime/app" "$ROOT/web-compute"; do
  (cd "$d" && SCRIPTC_CC=zigcc SCRIPTC_TARGET=wasm32-wasi node "$SCRIPTC" build --lib --profile profile.json >/dev/null)
  echo "built $(basename "$d")"
done
