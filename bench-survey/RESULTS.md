# Ranked results

Measured 2026-08-31 with scriptc `7aff23e7` and Node 24.15.0. Warm median of 201 paired, interleaved repetitions after 40 warmups. Ratio is compiled wasm / V8; values above 1 are slower.

| op | n | wasm ms | V8 ms | ratio | checksum |
|---|--:|--:|--:|--:|:--:|
| allocArrays | 200000 | 6.373 | 0.136 | 46.92x | yes |
| allocObjects | 200000 | 3.309 | 0.135 | 24.48x | yes |
| arrEvery | 5000 | 7.096 | 0.315 | 22.50x | yes |
| objLiteral | 200000 | 3.191 | 0.147 | 21.74x | yes |
| objFieldRW | 200000 | 2.732 | 0.130 | 20.94x | yes |
| arrSome | 2000 | 23.053 | 1.172 | 19.67x | yes |
| arrFind | 2000 | 12.064 | 0.622 | 19.38x | yes |
| strTrim | 4000 | 0.664 | 0.037 | 18.12x | yes |
| arrConcat | 2000 | 2.228 | 0.126 | 17.65x | yes |
| arrMap | 5000 | 2.185 | 0.157 | 13.94x | yes |
| arrShift | 8000 | 2.730 | 0.205 | 13.29x | yes |
| numBitOps | 10000 | 15.347 | 1.410 | 10.88x | yes |
| strSlice | 4000 | 0.338 | 0.032 | 10.56x | yes |
| strSubstring | 4000 | 0.338 | 0.033 | 10.28x | yes |
| strTemplate | 100000 | 13.394 | 1.357 | 9.87x | yes |
| strBuild | 20000 | 1.218 | 0.125 | 9.71x | yes |
| escapeObjects | 100000 | 4.312 | 0.494 | 8.73x | yes |
| escapeArrays | 100000 | 5.124 | 0.600 | 8.54x | yes |
| arrSlice | 5000 | 0.243 | 0.032 | 7.66x | yes |
| allocStrings | 100000 | 11.051 | 1.567 | 7.05x | yes |
| strEndsWith | 2000 | 0.127 | 0.019 | 6.76x | yes |
| arrPop | 20000 | 0.455 | 0.069 | 6.63x | yes |
| strIndexOf | 3000 | 0.198 | 0.031 | 6.49x | yes |
| strIncludes | 3000 | 0.198 | 0.031 | 6.34x | yes |
| strStartsWith | 2000 | 0.128 | 0.023 | 5.52x | yes |
| strCharCodeAt | 3000 | 1.984 | 0.379 | 5.23x | yes |
| arrPush | 20000 | 0.294 | 0.061 | 4.85x | yes |
| mapIterate | 5000 | 0.955 | 0.204 | 4.67x | yes |
| escapeStrings | 100000 | 12.127 | 2.657 | 4.56x | yes |
| strCompare | 5000 | 1.692 | 0.465 | 3.64x | yes |
| objSpread | 200000 | 3.459 | 0.979 | 3.53x | yes |
| strStrToNum | 100000 | 10.087 | 2.990 | 3.37x | yes |
| arrIncludes | 2000 | 1.790 | 0.567 | 3.15x | yes |
| arrSort | 2000 | 14.674 | 5.028 | 2.92x | yes |
| mapGet | 20000 | 1.750 | 0.604 | 2.90x | yes |
| strNumToStr | 100000 | 3.049 | 1.084 | 2.81x | yes |
| strRepeat | 200 | 0.033 | 0.014 | 2.41x | yes |
| arrFilter | 5000 | 1.275 | 0.568 | 2.25x | yes |
| jsonParse | 2000 | 13.356 | 5.950 | 2.24x | yes |
| arrJoin | 5000 | 2.167 | 1.086 | 2.00x | yes |
| arrForEach | 5000 | 0.776 | 0.398 | 1.95x | yes |
| arrIndexOf | 2000 | 0.574 | 0.303 | 1.90x | yes |
| jsonStringify | 2000 | 5.745 | 3.145 | 1.83x | yes |
| arrReduce | 5000 | 0.773 | 0.448 | 1.73x | yes |
| setAdd | 20000 | 0.490 | 0.288 | 1.70x | yes |
| strJoin | 5000 | 3.660 | 2.195 | 1.67x | yes |
| arrFlat | 2000 | 2.580 | 1.572 | 1.64x | yes |
| setHas | 20000 | 0.892 | 0.592 | 1.51x | yes |
| mapHas | 20000 | 0.896 | 0.597 | 1.50x | yes |
| strUpper | 4000 | 2.261 | 1.523 | 1.48x | yes |
| strSplit | 3000 | 3.359 | 2.360 | 1.42x | yes |
| mapSet | 20000 | 0.680 | 0.494 | 1.38x | yes |
| numIntLoop | 10000 | 8.340 | 6.406 | 1.30x | yes |
| numFloatMath | 10000 | 0.896 | 0.689 | 1.30x | yes |
| arrSplice | 6000 | 0.748 | 0.659 | 1.14x | yes |
| arrFill | 5000 | 0.324 | 0.289 | 1.12x | yes |
| mapDelete | 20000 | 0.893 | 0.844 | 1.06x | yes |
| numMathCalls | 200000 | 1.593 | 1.548 | 1.03x | yes |
| arrUnshift | 8000 | 2.517 | 2.536 | 0.99x | yes |
| arrReverse | 5000 | 0.210 | 0.300 | 0.70x | yes |

## Family ratios

| family | median | range | operations |
|---|--:|--:|--:|--:|
| alloc | 8.63x | 4.56–46.92x | 6 |
| array | 2.92x | 0.70–22.50x | 21 |
| json | 2.04x | 1.83–2.24x | 2 |
| map/set | 1.51x | 1.06–4.67x | 7 |
| numeric | 1.30x | 1.03–10.88x | 4 |
| object | 20.94x | 3.53–21.74x | 3 |
| string | 5.52x | 1.42–18.12x | 17 |

All 60 checksums matched. Ratios below roughly 1.1x are within observed machine noise.
