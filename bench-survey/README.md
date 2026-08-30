# scriptc compiled-wasm vs V8 stdlib survey

Measures common ops in compiled wasm (`scriptc build --lib`, wasm32-wasi, run in
Node's WebAssembly) against the identical source run in plain V8 (Node type-strip).
Same source file (`ops.ts`) drives both lanes, so the algorithm is byte-identical
and checksums must agree.

## Run

    ./build.sh      # rebuild ops.wasm + ops.mjs from ops.ts
    node run.mjs    # measure; writes RESULTS.md-equivalent to stdout + results.json
    node coldwarm.mjs   # cold(1st call) vs warm median, shows JIT tier-up

Env: `REPS` (default 201), `WARM` (default 40).

## Method

- One `ops.ts`; each `export function op(n)` does the op over size `n` and returns
  an f64 checksum (results consumed → no dead-code elimination on either side).
- wasm lane: `instantiateFromBytes` from the generated `.scriptc/ops.mjs`.
- v8 lane: `import("./ops.ts")` (Node 24 type-strip) — same functions.
- Per op: assert `wasm(n) === v8(n)` first (correctness gates speed), warm both,
  then time **interleaved in the same process**, alternating which lane goes first.
- Report **median** of REPS reps + min/max range. Ratios <~1.1x are noise on this
  machine (±10% run-to-run).

## Numbers are WARM

wasm starts in Node's baseline (Liftoff) tier and tiers up. `coldwarm.mjs` shows
first-call is ~1.2–1.7x slower than warm median. All figures in RESULTS.md are warm.

## What the ratio means

ratio = compiled_ms / v8_ms. >1 means the compiled lane is slower. V8 is a mature
JIT with escape analysis and int specialization; several ops (esp. allocation and
bit-int work) are cases where V8's optimizer is simply far ahead, not just wasm
being slow — see FINDINGS.md.

## Non-compiling ops

Recorded in FINDINGS.md; excluded from the timed set. `scriptc coverage ops.ts`
lists lowering blockers without building.
