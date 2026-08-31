# Findings

60 operations, compiled wasm versus V8, warm median of 201 paired and interleaved repetitions. `RESULTS.md` contains the full table.

## Family results

| family | median | range |
|---|--:|--:|
| numeric | 1.30x | 1.03–10.88x |
| map/set | 1.51x | 1.06–4.67x |
| json | 2.04x | 1.83–2.24x |
| array | 2.92x | 0.70–22.50x |
| string | 5.52x | 1.42–18.12x |
| allocation | 8.63x | 4.56–46.92x |
| object | 20.94x | 3.53–21.74x |

Sort is not an outlier. Random `arrSort` is 2.92x, matching the array-family median.

## Allocation and escape analysis

The original allocation cases consume each value immediately, so V8 can eliminate much of the work. Three escaping cases now retain every value and consume it in a second pass:

| shape | non-escaping | escaping |
|---|--:|--:|
| arrays | 46.92x | 8.54x |
| objects | 24.48x | 8.73x |
| strings | 7.05x | 4.56x |

The extreme ratios are therefore mostly missing escape analysis, not allocator throughput. Escaping values still cost 4.6–8.7x more than V8.

Initial array slots now share the array-header allocation and spill to separate storage only on growth. Against the prior run this reduced non-escaping `allocArrays` from 8.840 ms to 6.373 ms (28%) and the paired escaping probe from roughly 6.4 ms to 5.1 ms (about 20%). Full C/LLVM differential corpora and RC-audit array cases pass.

## Largest remaining losses

- Object literals and field access: 21–22x.
- `arrEvery`, `arrSome`, `arrFind`, and `arrConcat`: 18–23x.
- `strTrim`: 18.12x.
- String slice, substring, construction, and templates: 9.7–10.6x.
- Bitwise numeric work: 10.88x after native i32 lowering, down from the former 55x path.

## String and newly lowered operations

Upstream string self-concatenation ownership reduced `strBuild` from 4.526 ms to about 1.2 ms, a 73% reduction. Its ratio fell from 39.91x to 9.71x.

`Array.prototype.fill`, `Array.prototype.flat`, and `String.prototype.toUpperCase` are included:

- `arrFill`: 1.12x.
- `arrFlat`: 1.64x.
- `strUpper`: 1.48x.

The case-conversion benchmark varies its input on every iteration and includes character codes in its checksum. The former length-only checksum could not detect a no-op conversion, and repeated conversion of one immutable string allowed V8 to hoist or reuse work. An ASCII runtime fast path reduced the original invariant compiled workload from 13.46 ms to 2.21 ms before the instrument was corrected; Unicode inputs retain the table-driven path.

## Correctness and method

All 60 checksums matched. Both lanes execute the same `ops.ts`, are warmed, alternate measurement order, and run in one process. Ratios below roughly 1.1x are machine noise on this system.

The largest runtime work remains object representation, escaping allocations, high-overhead array callbacks, and common string scans/copies.
