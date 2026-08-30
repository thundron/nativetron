# Findings

54 ops timed, wasm vs V8, warm, median of 201 interleaved reps. Full ranked table:
RESULTS.md. Representative run below (±10% machine noise; ratios <~1.1x are noise).

## Direct answer: is sort an outlier?

No. `arrSort` is ~4x — mid-pack, and NOT the worst. The compiled stdlib is broadly
slower than V8, with a long tail far worse than sort. The ~9x sort figure from the
prior single-op benchmark understates the spread: many ordinary ops are 10–70x.
sort is unremarkable.

## Family verdict

| family | median ratio | range | verdict |
|---|--:|--:|---|
| numeric | 1.3x | 1.05–55x | competitive EXCEPT bit ops |
| map/set | 1.4x | 0.85–4.2x | competitive |
| json    | 1.9x | 1.7–2.0x | acceptable |
| array   | 4.3x | 0.53–24.8x | bad, wide spread |
| string  | 9.0x | 1.4–39.9x | bad |
| object  | 21.7x | 3.3–23.2x | very bad |
| alloc   | 24.1x | 6.9–69x | very bad |

Competitive (<=1.5x): float math, `Math.*` calls, integer loop, Map set/has/delete,
Set add, arrUnshift, arrReverse (faster than V8), arrSplice.

Bad (>3x): all allocation, most object ops, string build/scan/slice, arrEvery/Some/
Find/Map/Concat, bit ops.

## The two real pathologies

1. **Allocation of small objects/arrays/strings (7–70x).** `allocArrays` 200k tiny
   arrays = ~70x. V8 escape-analyzes and often elides the allocation entirely
   (0.13ms for 200k); the compiled lane really allocates. Caveat: part of this gap
   is V8 eliding work, not only wasm being slow — but the compiled lane has no
   equivalent escape analysis, so the allocation cost is real for it.
2. **Bit ops on numbers (55x).** `numBitOps` (`<<`,`>>`,`^`,`|`) = 55x while the
   arithmetic-only `numIntLoop` is 1.25x and `numMathCalls` is ~1.05x. Numbers are
   modeled as f64 everywhere; each bitwise op needs f64->i32->f64 conversion. This
   is the single worst *compute* op and contradicts any assumption that "integer"
   code is fast — only non-bitwise integer arithmetic is.

Object field R/W and object-literal creation at ~22x is the other systemic loss:
the object model is heap-boxed with no V8-style hidden-class/inline-cache speedup.

`arrReverse` (0.5x) and `mapDelete`/`arrUnshift` (~0.9–1.0x) are the only wins/ties.

## Non-compiling ops (cannot be measured)

| op | why | code |
|---|---|---|
| `Array.prototype.fill` | no scriptc lowering | SC2020 (build error) |
| `Array.prototype.flat` | no scriptc lowering | SC2020 (build error) |
| `String.prototype.toUpperCase` | lowers, but wasm link fails: `undefined symbol: scr_str_to_upper` (no wasm32-wasi runtime impl) | link error |

`fill`/`flat` fail typecheck-time with a code frame. `toUpperCase` passes coverage
and IR lowering but the wasm runtime lacks the symbol, so `build --lib` fails at
`wasm-ld`. (Likely native-only; a wasm gap, not a language gap.) Minimal repros in
`repro/`.

## Correctness mismatches

None. All 54 compiled checksums equal the V8 checksums exactly.

## Caveats stated plainly

- Warm numbers only; cold first-call is ~1.2–1.7x slower (`coldwarm.mjs`).
- Some huge ratios (alloc) partly reflect V8's optimizer eliding work rather than
  the compiled lane being absurd; both are honest "what you get" numbers.
- Ops sized so one call is tens-of-µs to low-ms; per-call wasm FFI overhead
  (~sub-µs) is negligible at these sizes.
