#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SCRIPTC="${SCRIPTC:-$ROOT/../../../scriptc/packages/cli/dist/main.js}"
for d in "$ROOT/web-runtime/app" "$ROOT/web-compute"; do
  (cd "$d" && SCRIPTC_CC=zigcc SCRIPTC_TARGET=wasm32-wasi node "$SCRIPTC" build --lib --profile profile.json >/dev/null)
  echo "built $(basename "$d")"
done
(
  cd "$ROOT/web-react"
  if [[ ! -x node_modules/.bin/esbuild ]]; then npm ci --silent; fi
  npx esbuild app.jsx --bundle --minify --format=esm --jsx=automatic \
    '--define:process.env.NODE_ENV="production"' --outfile=bundle.js >/dev/null
)
echo "built web-react"
