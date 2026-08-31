# Findings

57 operations, compiled wasm versus V8, warm median of 201 paired and interleaved repetitions. `RESULTS.md` contains the full table.

## Family results

| family | median | range |
|---|--:|--:|
| numeric | 1.30x | 1.00–10.81x |
| map/set | 1.46x | 1.01–4.83x |
| json | 2.11x | 1.87–2.34x |
| array | 2.94x | 0.72–22.52x |
| string | 5.86x | 1.36–18.60x |
| object | 21.31x | 3.65–23.53x |
| allocation | 24.35x | 6.98–64.31x |

Sort is not an outlier. Random `arrSort` is 2.94x, close to the array-family median.

## Largest remaining losses

- `allocArrays`: 64.31x.
- `allocObjects`, object literals, and object field access: 21–24x.
- `arrEvery`, `arrSome`, `arrFind`, and `arrConcat`: 19–23x.
- `strTrim`: 18.60x.
- String slice, substring, construction, and templates: 9.9–11.1x.
- Bitwise numeric work: 10.81x after native i32 lowering, down from the former 55x path.

The allocation ratios partly measure V8 escape analysis eliminating work that the compiled lane performs. That is still an application-visible disadvantage of the compiled lane.

## Changes since the previous run

Upstream string self-concatenation ownership reduced `strBuild` from 4.526 ms to 1.166 ms, a 74% reduction. Its ratio fell from 39.91x to 10.33x.

`Array.prototype.fill`, `Array.prototype.flat`, and `String.prototype.toUpperCase` now compile in wasm and are included in the survey:

- `arrFill`: 1.12x.
- `arrFlat`: 1.58x.
- `strUpper`: 1.49x.

The case-conversion benchmark now varies its input on every iteration and includes character codes in its checksum. The former length-only checksum could not detect a no-op conversion, and repeated conversion of one immutable string allowed V8 to hoist or reuse work. An ASCII runtime fast path reduced the original invariant compiled workload from 13.46 ms to 2.21 ms before the instrument was corrected; Unicode inputs retain the table-driven path.

## Correctness and method

All 57 checksums matched. Both lanes execute the same `ops.ts`, are warmed, alternate measurement order, and run in one process. Ratios below roughly 1.1x are machine noise on this system.

The largest runtime work remains allocation, object representation, high-overhead array callbacks, and common string scans/copies.
