# Ranked results

Measured 2026-09-07 with scriptc `032123ab` and Node 24.15.0. Warm median of 201 paired, interleaved repetitions after 40 warmups. Ratio is compiled wasm / V8; values above 1 are slower.

| op | n | wasm ms | V8 ms | ratio | checksum |
|---|--:|--:|--:|--:|:--:|
| allocArrays | 200000 | 5.676 | 0.136 | 41.63x | yes |
| allocObjects | 200000 | 3.104 | 0.135 | 22.95x | yes |
| objLiteral | 200000 | 2.749 | 0.142 | 19.33x | yes |
| strTrim | 4000 | 0.684 | 0.039 | 17.67x | yes |
| arrConcat | 2000 | 2.246 | 0.127 | 17.63x | yes |
| arrEvery | 5000 | 5.568 | 0.320 | 17.40x | yes |
| arrFind | 2000 | 8.826 | 0.595 | 14.82x | yes |
| arrSome | 2000 | 17.109 | 1.175 | 14.56x | yes |
| arrShift | 8000 | 2.777 | 0.212 | 13.12x | yes |
| arrMap | 5000 | 1.823 | 0.159 | 11.46x | yes |
| numBitOps | 10000 | 16.351 | 1.539 | 10.63x | yes |
| strBuild | 20000 | 1.154 | 0.122 | 9.46x | yes |
| strTemplate | 100000 | 12.814 | 1.380 | 9.28x | yes |
| strSubstring | 4000 | 0.258 | 0.033 | 7.93x | yes |
| arrSlice | 5000 | 0.243 | 0.031 | 7.91x | yes |
| escapeArrays | 100000 | 4.891 | 0.622 | 7.86x | yes |
| escapeObjects | 100000 | 3.923 | 0.503 | 7.80x | yes |
| strSlice | 4000 | 0.262 | 0.034 | 7.73x | yes |
| strEndsWith | 2000 | 0.129 | 0.018 | 7.07x | yes |
| arrPop | 20000 | 0.468 | 0.070 | 6.73x | yes |
| allocStrings | 100000 | 10.382 | 1.585 | 6.55x | yes |
| strIndexOf | 3000 | 0.201 | 0.032 | 6.37x | yes |
| strIncludes | 3000 | 0.197 | 0.031 | 6.24x | yes |
| strStartsWith | 2000 | 0.128 | 0.023 | 5.62x | yes |
| strCharCodeAt | 3000 | 2.061 | 0.394 | 5.23x | yes |
| mapIterate | 5000 | 0.955 | 0.206 | 4.64x | yes |
| escapeStrings | 100000 | 11.568 | 2.690 | 4.30x | yes |
| arrPush | 20000 | 0.260 | 0.061 | 4.24x | yes |
| strStrToNum | 100000 | 9.907 | 3.081 | 3.22x | yes |
| objSpread | 200000 | 3.197 | 0.994 | 3.22x | yes |
| arrIncludes | 2000 | 1.797 | 0.569 | 3.16x | yes |
| strCompare | 5000 | 1.382 | 0.477 | 2.90x | yes |
| mapGet | 20000 | 1.742 | 0.648 | 2.69x | yes |
| strNumToStr | 100000 | 2.865 | 1.082 | 2.65x | yes |
| strRepeat | 200 | 0.030 | 0.012 | 2.45x | yes |
| jsonParse | 2000 | 13.348 | 6.049 | 2.21x | yes |
| arrJoin | 5000 | 2.143 | 1.091 | 1.96x | yes |
| arrFilter | 5000 | 1.068 | 0.560 | 1.91x | yes |
| arrIndexOf | 2000 | 0.574 | 0.303 | 1.90x | yes |
| setAdd | 20000 | 0.502 | 0.269 | 1.87x | yes |
| jsonStringify | 2000 | 5.920 | 3.235 | 1.83x | yes |
| arrSort | 2000 | 8.694 | 5.028 | 1.73x | yes |
| strJoin | 5000 | 3.615 | 2.222 | 1.63x | yes |
| mapHas | 20000 | 0.907 | 0.589 | 1.54x | yes |
| arrForEach | 5000 | 0.619 | 0.410 | 1.51x | yes |
| setHas | 20000 | 0.911 | 0.615 | 1.48x | yes |
| strUpper | 4000 | 2.297 | 1.554 | 1.48x | yes |
| strSplit | 3000 | 3.499 | 2.421 | 1.45x | yes |
| numFloatMath | 10000 | 0.958 | 0.718 | 1.33x | yes |
| arrReduce | 5000 | 0.606 | 0.467 | 1.30x | yes |
| numIntLoop | 10000 | 8.762 | 6.782 | 1.29x | yes |
| arrFlat | 2000 | 2.042 | 1.586 | 1.29x | yes |
| mapSet | 20000 | 0.684 | 0.544 | 1.26x | yes |
| arrSplice | 6000 | 0.747 | 0.661 | 1.13x | yes |
| arrFill | 5000 | 0.327 | 0.290 | 1.13x | yes |
| numMathCalls | 200000 | 1.587 | 1.565 | 1.01x | yes |
| arrUnshift | 8000 | 2.520 | 2.558 | 0.99x | yes |
| objFieldRW | 200000 | 0.133 | 0.136 | 0.98x | yes |
| mapDelete | 20000 | 0.939 | 0.970 | 0.97x | yes |
| arrReverse | 5000 | 0.213 | 0.392 | 0.54x | yes |

## Family ratios

| family | median | range | operations |
|---|--:|--:|--:|
| alloc | 7.83x | 4.30–41.63x | 6 |
| array | 1.96x | 0.54–17.63x | 21 |
| json | 2.02x | 1.83–2.21x | 2 |
| map/set | 1.54x | 0.97–4.64x | 7 |
| numeric | 1.31x | 1.01–10.63x | 4 |
| object | 3.22x | 0.98–19.33x | 3 |
| string | 5.62x | 1.45–17.67x | 17 |

All 60 checksums matched. Ratios below roughly 1.1x are within observed machine noise.
