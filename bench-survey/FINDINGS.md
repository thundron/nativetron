# Findings

60 operations, compiled wasm versus V8, warm median of 201 paired and interleaved repetitions. `RESULTS.md` contains the full table.

## Family results

| family | median | range |
|---|--:|--:|
| numeric | 1.30x | 1.04–10.69x |
| map/set | 1.45x | 0.85–4.78x |
| json | 1.78x | 1.68–1.87x |
| array | 1.92x | 0.43–17.30x |
| object | 3.27x | 0.98–18.34x |
| string | 5.30x | 0.89–18.35x |
| allocation | 7.20x | 4.21–41.73x |

Random `arrSort` is 1.78x. All 60 checksums matched.

## Stable receiver ownership

Direct reads and writes through unboxed local array, record, and class receivers now borrow the receiver when later operands cannot overwrite its binding. Uncertain evaluation order retains the receiver; reassignment in an index or right-hand side is covered in both C and LLVM differential tests.

`objFieldRW` fell from 2.732 ms to 0.119 ms, and from 20.94x to 0.98x. The generated hot loop has no receiver retain/release pairs. Array callback cases also improved:

| operation | previous | current |
|---|--:|--:|
| `arrEvery` | 22.50x | 17.30x |
| `arrSome` | 19.67x | 14.03x |
| `arrFind` | 19.38x | 14.98x |
| `arrMap` | 13.94x | 11.54x |
| `arrReduce` | 1.73x | 1.32x |
| `arrForEach` | 1.95x | 1.58x |

## Allocation and escape analysis

The non-escaping allocation cases consume each value immediately, so V8 can eliminate much of the work. The escaping cases retain every value and consume it in a second pass:

| shape | non-escaping | escaping |
|---|--:|--:|
| arrays | 41.73x | 7.47x |
| objects | 21.58x | 6.92x |
| strings | 6.93x | 4.21x |

The extreme ratios primarily measure missing escape analysis rather than allocator throughput. Escaping values remain 4.2–7.5x slower than V8.

Initial array slots share the array-header allocation and spill to separate storage only on growth. That earlier change reduced non-escaping array allocation by about 28% and escaping array allocation by about 20%.

## Largest remaining losses

- Non-escaping array and object allocation: 21.58–41.73x.
- Object literals: 18.34x; direct field access is no longer a loss.
- `strTrim`: 18.35x.
- `arrEvery`, `arrFind`, `arrSome`, `arrConcat`, and `arrMap`: 11.5–17.3x.
- String slice, substring, construction, and templates: 8.7–10.5x.
- Bitwise numeric work: 10.69x after native i32 lowering, down from the former 55x path.

## Correctness and method

Both lanes execute the same `ops.ts`, are warmed, alternate measurement order, and run in one process. Ratios below roughly 1.1x are machine noise on this system.

The remaining runtime work is allocation and escape analysis, high-overhead array callbacks and concatenation, object literal allocation, and common string scans and copies.
