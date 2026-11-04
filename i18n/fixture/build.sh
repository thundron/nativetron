#!/usr/bin/env bash
# Builds the compiled i18n fixture as a wasm32-wasi reactor and as a host static library plus C harness.
# Outputs: i18n/fixture/.scriptc/fixture.{wasm,mjs}, fixture.lib.a and harness.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../scriptc/packages/cli/dist/main.js}"
node "$ROOT/i18n/generate.mjs" --check
cd "$HERE"
SCRIPTC_TARGET=wasm32-wasi SCRIPTC_CC="${SCRIPTC_CC:-zigcc}" node "$SCRIPTC" build --lib --profile profile.json
env -u SCRIPTC_TARGET node "$SCRIPTC" build --lib --profile profile.json
"${CC:-clang}" -std=c11 -Wall -Wextra -Werror -O1 harness.c .scriptc/fixture.lib.a -o .scriptc/harness
