# Findings

60 operations, compiled wasm versus V8, warm median of 201 paired and interleaved repetitions. `RESULTS.md` contains the full table.

## Family results

| family | median | range |
|---|--:|--:|
| numeric | 1.31x | 1.01–10.63x |
| map/set | 1.54x | 0.97–4.64x |
| array | 1.96x | 0.54–17.63x |
| json | 2.02x | 1.83–2.21x |
| object | 3.22x | 0.98–19.33x |
| string | 5.62x | 1.45–17.67x |
| allocation | 7.83x | 4.30–41.63x |

Random `arrSort` is 1.73x. All 60 checksums matched.

## Sparse UTF-16 index overhead

The first 0.0.36 measurement exposed short-string regressions from the new sparse UTF-16 cache: every temporary string release probed both cache tables, cursor eviction cleared the full sparse entry, and numeric ASCII strings entered the cache solely to answer `.length`.

Heap strings now reserve two low capacity bits for cache residency and proven ASCII. Unindexed releases and appends skip cache-table scans, short cursor entries clear only cursor state, known ASCII lengths bypass the cache, and numeric formatting marks its ASCII result. Sparse indexing for large mixed UTF-8 strings is unchanged.

Against the pre-fix 0.0.36 run, compiled medians changed as follows:

| operation | pre-fix ms | current ms |
|---|--:|--:|
| `strNumToStr` | 4.355 | 2.865 |
| `strCharCodeAt` | 2.497 | 2.061 |
| `allocStrings` | 13.851 | 10.382 |
| `strTemplate` | 16.428 | 12.814 |
| `strSlice` | 0.383 | 0.262 |
| `strSubstring` | 0.393 | 0.258 |
| `strBuild` | 1.348 | 1.154 |

The string family median moved from 6.83x pre-fix to 5.62x. Runtime string oracles, ASan/RC audit tests, and all 1,103 C and LLVM differential programs pass.

## Stable receiver ownership

Direct reads and writes through unboxed local array, record, and class receivers borrow the receiver when later operands cannot overwrite its binding. Uncertain evaluation order retains the receiver; reassignment in an index or right-hand side is covered in both C and LLVM differential tests.

`objFieldRW` remains at 0.98x. The generated hot loop has no receiver retain/release pairs.

## Allocation and escape analysis

The non-escaping allocation cases consume each value immediately, so V8 can eliminate much of the work. The escaping cases retain every value and consume it in a second pass:

| shape | non-escaping | escaping |
|---|--:|--:|
| arrays | 41.63x | 7.86x |
| objects | 22.95x | 7.80x |
| strings | 6.55x | 4.30x |

The extreme ratios primarily measure missing escape analysis rather than allocator throughput. Escaping values remain 4.3–7.9x slower than V8.

Initial array slots share the array-header allocation and spill to separate storage only on growth.

## Largest remaining losses

- Non-escaping array and object allocation: 22.95–41.63x.
- Object literals: 19.33x; direct field access is not a loss.
- `strTrim`: 17.67x.
- `arrConcat`, `arrEvery`, `arrFind`, `arrSome`, and `arrMap`: 11.5–17.6x.
- String slice, substring, construction, and templates: 7.7–9.5x.
- Bitwise numeric work: 10.63x.

`arrConcat`'s ratio rose from 11.95x even though compiled time changed only from 2.173 ms to 2.246 ms; V8's median fell from 0.182 ms to 0.127 ms. Cross-run ratios are not treated as compiler-only measurements.

## Method

Both lanes execute the same `ops.ts`, are warmed, alternate measurement order, and run in one process. Every result is checksum-gated. Ratios below roughly 1.1x are machine noise on this system.

Allocation, array callbacks and concatenation, object literals, and common string scans and copies remain materially slower than V8.
