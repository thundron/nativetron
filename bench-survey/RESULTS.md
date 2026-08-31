# Ranked results

Measured 2026-08-31 with scriptc `a215b50c` and Node 24.15.0. Warm median of 201 paired, interleaved repetitions after 40 warmups. Ratio is compiled wasm / V8; values above 1 are slower.

| op | n | wasm ms | V8 ms | ratio | checksum |
|---|--:|--:|--:|--:|:--:|
| allocArrays | 200000 | 8.840 | 0.137 | 64.31x | yes |
| allocObjects | 200000 | 3.250 | 0.134 | 24.35x | yes |
| objLiteral | 200000 | 3.264 | 0.139 | 23.53x | yes |
| arrEvery | 5000 | 7.110 | 0.316 | 22.52x | yes |
| objFieldRW | 200000 | 2.691 | 0.126 | 21.31x | yes |
| arrSome | 2000 | 24.061 | 1.172 | 20.52x | yes |
| arrConcat | 2000 | 2.398 | 0.125 | 19.21x | yes |
| arrFind | 2000 | 11.914 | 0.626 | 19.02x | yes |
| strTrim | 4000 | 0.675 | 0.036 | 18.60x | yes |
| arrMap | 5000 | 2.341 | 0.157 | 14.92x | yes |
| arrShift | 8000 | 2.709 | 0.207 | 13.11x | yes |
| strSlice | 4000 | 0.335 | 0.030 | 11.05x | yes |
| numBitOps | 10000 | 15.126 | 1.400 | 10.81x | yes |
| strSubstring | 4000 | 0.338 | 0.033 | 10.37x | yes |
| strBuild | 20000 | 1.166 | 0.113 | 10.33x | yes |
| strTemplate | 100000 | 13.339 | 1.352 | 9.86x | yes |
| arrSlice | 5000 | 0.227 | 0.030 | 7.67x | yes |
| strEndsWith | 2000 | 0.133 | 0.019 | 7.17x | yes |
| allocStrings | 100000 | 10.948 | 1.569 | 6.98x | yes |
| arrPop | 20000 | 0.448 | 0.067 | 6.64x | yes |
| strIndexOf | 3000 | 0.195 | 0.032 | 6.14x | yes |
| strIncludes | 3000 | 0.191 | 0.032 | 5.97x | yes |
| strStartsWith | 2000 | 0.130 | 0.022 | 5.86x | yes |
| strCharCodeAt | 3000 | 1.982 | 0.353 | 5.61x | yes |
| arrPush | 20000 | 0.309 | 0.060 | 5.16x | yes |
| mapIterate | 5000 | 0.963 | 0.199 | 4.83x | yes |
| strCompare | 5000 | 1.736 | 0.472 | 3.67x | yes |
| objSpread | 200000 | 3.551 | 0.973 | 3.65x | yes |
| strStrToNum | 100000 | 9.938 | 2.997 | 3.32x | yes |
| arrIncludes | 2000 | 1.782 | 0.568 | 3.14x | yes |
| arrSort | 2000 | 14.878 | 5.069 | 2.94x | yes |
| strRepeat | 200 | 0.038 | 0.014 | 2.77x | yes |
| strNumToStr | 100000 | 2.928 | 1.082 | 2.71x | yes |
| mapGet | 20000 | 1.691 | 0.648 | 2.61x | yes |
| jsonParse | 2000 | 13.994 | 5.981 | 2.34x | yes |
| arrFilter | 5000 | 1.256 | 0.564 | 2.23x | yes |
| arrIndexOf | 2000 | 0.612 | 0.296 | 2.07x | yes |
| arrForEach | 5000 | 0.781 | 0.394 | 1.98x | yes |
| arrJoin | 5000 | 2.136 | 1.093 | 1.95x | yes |
| jsonStringify | 2000 | 6.040 | 3.224 | 1.87x | yes |
| arrReduce | 5000 | 0.836 | 0.463 | 1.81x | yes |
| strJoin | 5000 | 3.588 | 2.221 | 1.62x | yes |
| arrFlat | 2000 | 2.531 | 1.600 | 1.58x | yes |
| setHas | 20000 | 0.903 | 0.579 | 1.56x | yes |
| strUpper | 4000 | 2.301 | 1.541 | 1.49x | yes |
| mapSet | 20000 | 0.678 | 0.464 | 1.46x | yes |
| setAdd | 20000 | 0.496 | 0.341 | 1.45x | yes |
| mapHas | 20000 | 0.893 | 0.624 | 1.43x | yes |
| strSplit | 3000 | 3.196 | 2.347 | 1.36x | yes |
| numFloatMath | 10000 | 0.887 | 0.674 | 1.32x | yes |
| numIntLoop | 10000 | 8.205 | 6.407 | 1.28x | yes |
| arrSplice | 6000 | 0.772 | 0.652 | 1.18x | yes |
| arrFill | 5000 | 0.323 | 0.287 | 1.12x | yes |
| mapDelete | 20000 | 0.900 | 0.893 | 1.01x | yes |
| numMathCalls | 200000 | 1.549 | 1.546 | 1.00x | yes |
| arrUnshift | 8000 | 2.496 | 2.513 | 0.99x | yes |
| arrReverse | 5000 | 0.213 | 0.296 | 0.72x | yes |

## Family ratios

| family | median | range | operations |
|---|--:|--:|--:|
| alloc | 24.35x | 6.98–64.31x | 3 |
| array | 2.94x | 0.72–22.52x | 21 |
| json | 2.11x | 1.87–2.34x | 2 |
| map/set | 1.46x | 1.01–4.83x | 7 |
| numeric | 1.30x | 1.00–10.81x | 4 |
| object | 21.31x | 3.65–23.53x | 3 |
| string | 5.86x | 1.36–18.60x | 17 |

All 57 checksums matched. Ratios below roughly 1.1x are within observed machine noise.
