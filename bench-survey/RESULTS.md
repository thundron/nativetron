# Ranked results

Measured 2026-08-31 with scriptc `51e26797` and Node 24.15.0. Warm median of 201 paired, interleaved repetitions after 40 warmups. Ratio is compiled wasm / V8; values above 1 are slower.

| op | n | wasm ms | V8 ms | ratio | checksum |
|---|--:|--:|--:|--:|:--:|
| allocArrays | 200000 | 5.541 | 0.133 | 41.73x | yes |
| allocObjects | 200000 | 3.023 | 0.140 | 21.58x | yes |
| strTrim | 4000 | 0.639 | 0.035 | 18.35x | yes |
| objLiteral | 200000 | 2.690 | 0.147 | 18.34x | yes |
| arrEvery | 5000 | 5.373 | 0.311 | 17.30x | yes |
| arrFind | 2000 | 9.212 | 0.615 | 14.98x | yes |
| arrSome | 2000 | 16.253 | 1.158 | 14.03x | yes |
| arrConcat | 2000 | 2.173 | 0.182 | 11.95x | yes |
| arrMap | 5000 | 2.079 | 0.180 | 11.54x | yes |
| arrShift | 8000 | 2.635 | 0.230 | 11.44x | yes |
| numBitOps | 10000 | 14.435 | 1.351 | 10.69x | yes |
| strBuild | 20000 | 1.115 | 0.107 | 10.45x | yes |
| strTemplate | 100000 | 12.901 | 1.338 | 9.64x | yes |
| strSlice | 4000 | 0.340 | 0.037 | 9.24x | yes |
| arrSlice | 5000 | 0.256 | 0.029 | 8.98x | yes |
| strSubstring | 4000 | 0.321 | 0.037 | 8.72x | yes |
| escapeArrays | 100000 | 4.733 | 0.633 | 7.47x | yes |
| allocStrings | 100000 | 10.659 | 1.539 | 6.93x | yes |
| escapeObjects | 100000 | 3.741 | 0.541 | 6.92x | yes |
| arrPop | 20000 | 0.445 | 0.068 | 6.51x | yes |
| strIncludes | 3000 | 0.185 | 0.030 | 6.20x | yes |
| strIndexOf | 3000 | 0.185 | 0.031 | 5.94x | yes |
| strEndsWith | 2000 | 0.131 | 0.023 | 5.75x | yes |
| strStartsWith | 2000 | 0.129 | 0.024 | 5.30x | yes |
| strCharCodeAt | 3000 | 1.922 | 0.375 | 5.13x | yes |
| mapIterate | 5000 | 1.075 | 0.225 | 4.78x | yes |
| escapeStrings | 100000 | 11.229 | 2.666 | 4.21x | yes |
| arrPush | 20000 | 0.254 | 0.062 | 4.10x | yes |
| objSpread | 200000 | 3.124 | 0.956 | 3.27x | yes |
| strStrToNum | 100000 | 9.461 | 2.991 | 3.16x | yes |
| arrIncludes | 2000 | 1.742 | 0.553 | 3.15x | yes |
| strCompare | 5000 | 1.311 | 0.458 | 2.86x | yes |
| strNumToStr | 100000 | 2.899 | 1.079 | 2.69x | yes |
| strRepeat | 200 | 0.033 | 0.012 | 2.68x | yes |
| mapGet | 20000 | 1.681 | 0.661 | 2.54x | yes |
| arrFilter | 5000 | 1.056 | 0.549 | 1.92x | yes |
| arrIndexOf | 2000 | 0.559 | 0.293 | 1.91x | yes |
| arrJoin | 5000 | 2.001 | 1.058 | 1.89x | yes |
| jsonParse | 2000 | 13.033 | 6.964 | 1.87x | yes |
| arrSort | 2000 | 8.538 | 4.806 | 1.78x | yes |
| setAdd | 20000 | 0.486 | 0.286 | 1.70x | yes |
| jsonStringify | 2000 | 5.489 | 3.268 | 1.68x | yes |
| strJoin | 5000 | 3.467 | 2.138 | 1.62x | yes |
| arrForEach | 5000 | 0.602 | 0.380 | 1.58x | yes |
| setHas | 20000 | 0.884 | 0.611 | 1.45x | yes |
| strSplit | 3000 | 3.276 | 2.416 | 1.36x | yes |
| numFloatMath | 10000 | 0.880 | 0.658 | 1.34x | yes |
| arrReduce | 5000 | 0.595 | 0.451 | 1.32x | yes |
| arrFlat | 2000 | 1.971 | 1.545 | 1.28x | yes |
| numIntLoop | 10000 | 7.964 | 6.323 | 1.26x | yes |
| mapHas | 20000 | 0.881 | 0.702 | 1.25x | yes |
| arrSplice | 6000 | 0.732 | 0.645 | 1.14x | yes |
| mapSet | 20000 | 0.670 | 0.597 | 1.12x | yes |
| numMathCalls | 200000 | 1.540 | 1.474 | 1.04x | yes |
| objFieldRW | 200000 | 0.119 | 0.122 | 0.98x | yes |
| arrUnshift | 8000 | 2.408 | 2.475 | 0.97x | yes |
| strUpper | 4000 | 2.220 | 2.507 | 0.89x | yes |
| mapDelete | 20000 | 0.897 | 1.054 | 0.85x | yes |
| arrFill | 5000 | 0.305 | 0.490 | 0.62x | yes |
| arrReverse | 5000 | 0.211 | 0.487 | 0.43x | yes |

## Family ratios

| family | median | range | operations |
|---|--:|--:|--:|
| alloc | 7.20x | 4.21–41.73x | 6 |
| array | 1.92x | 0.43–17.30x | 21 |
| json | 1.78x | 1.68–1.87x | 2 |
| map/set | 1.45x | 0.85–4.78x | 7 |
| numeric | 1.30x | 1.04–10.69x | 4 |
| object | 3.27x | 0.98–18.34x | 3 |
| string | 5.30x | 0.89–18.35x | 17 |

All 60 checksums matched. Ratios below roughly 1.1x are within observed machine noise.
