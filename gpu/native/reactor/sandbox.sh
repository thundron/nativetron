#!/usr/bin/env bash
# Prepares the read-only consumer sandbox for record-app.mjs / scenario.mjs / post.mjs (one /tmp namespace).
#   gpu/native/reactor/sandbox.sh [--root /tmp/nt-reactor-e2e] [--consumer ~/Documents/development/house-planner]
#                                 [--engine-wasm-dir /tmp/nt-native-reactor-1/out/wasm]
# Never writes to the consumer: `git archive HEAD` of it, APFS clones (cp -c) of its node_modules (pnpm layout,
# relative links), its gitignored generated sources regenerated inside the copy, nativetron's engine/gpu/ipc from
# this worktree's HEAD as the `nativetron` link, and the canonical engine wasm (built from the same consumer HEAD)
# in apps/web/public/engine. Records the consumer's HEAD and porcelain status before and after.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
ROOT=/tmp/nt-reactor-e2e
CONSUMER="$HOME/Documents/development/house-planner"
WASM=/tmp/nt-native-reactor-1/out/wasm
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --consumer) CONSUMER="$2"; shift 2 ;;
    --engine-wasm-dir) WASM="$2"; shift 2 ;;
    *) echo "sandbox: unknown argument $1" >&2; exit 2 ;;
  esac
done
HP="$ROOT/hp"
[[ -e "$HP" ]] && { echo "sandbox: $HP exists (remove it first)" >&2; exit 2; }
mkdir -p "$HP" "$ROOT/provenance" "$ROOT/nativetron"
git -C "$CONSUMER" rev-parse HEAD > "$ROOT/provenance/house-planner.head"
git -C "$CONSUMER" status --porcelain > "$ROOT/provenance/house-planner.status.before"
git -C "$CONSUMER" archive HEAD | tar -x -C "$HP"
mkdir -p "$HP/node_modules"
( cd "$CONSUMER/node_modules" && for e in .bin .modules.yaml .pnpm * .[!.]*; do
    case "$e" in nativetron|.vite|.vite-temp|.pnpm-task-run-state-v1|.pnpm-workspace-state-v1.json|'.[!.]*'|'*') continue ;; esac
    [[ -e "$HP/node_modules/$e" || ! -e "$e" ]] || cp -cRP "$e" "$HP/node_modules/"
  done )
for d in "$CONSUMER"/apps/web "$CONSUMER"/packages/*; do
  rel="${d#"$CONSUMER"/}"
  [[ -d "$d/node_modules" ]] || continue
  mkdir -p "$HP/$rel/node_modules"
  for e in "$d"/node_modules/* "$d"/node_modules/.bin; do
    [[ -e "$e" || -L "$e" ]] || continue
    case "$e" in *.vite*) continue ;; esac
    cp -cRP "$e" "$HP/$rel/node_modules/"
  done
done
if find "$HP" -type l -lname '/*' | grep -q .; then echo "sandbox: absolute links into the consumer remain" >&2; exit 1; fi
git -C "$REPO" archive HEAD engine gpu ipc | tar -x -C "$ROOT/nativetron"
ln -sfn ../../nativetron "$HP/node_modules/nativetron"
( cd "$HP/packages/schema" && TMPDIR="$ROOT" node scripts/gen-types.mjs )
( cd "$HP/packages/catalog" && TMPDIR="$ROOT" node scripts/gen.mjs )
mkdir -p "$HP/apps/web/public/engine"
cp "$WASM/hp-engine.wasm" "$WASM/hp-engine.mjs" "$HP/apps/web/public/engine/"
shasum -a 256 "$HP/apps/web/public/engine/"* > "$ROOT/provenance/engine-wasm.sha256"
git -C "$CONSUMER" status --porcelain > "$ROOT/provenance/house-planner.status.after"
cmp -s "$ROOT/provenance/house-planner.status.before" "$ROOT/provenance/house-planner.status.after" || { echo "sandbox: consumer status changed" >&2; exit 1; }
printf '%s\n' "$HP"
