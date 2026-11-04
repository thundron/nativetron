#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../scriptc/packages/cli/dist/main.js}"
node "$ROOT/ipc/generate-control.mjs" --check
node "$ROOT/ipc/generate-engine.mjs" --check
cd "$ROOT/ipc"
node "$SCRIPTC" build --lib --profile control-profile.json
