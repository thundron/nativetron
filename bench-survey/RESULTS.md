# Ranked results (worst ratio first)

Warm, median of 201 interleaved reps. ratio = compiled_ms / v8_ms (>1 = compiled slower).

| op | n | wasm ms | v8 ms | ratio | ok |
|---|--:|--:|--:|--:|--|
| allocArrays | 200000 | 9.335 | 0.135 | 69.02x | y |
| numBitOps | 10000 | 73.525 | 1.335 | 55.06x | y |
| strBuild | 20000 | 4.526 | 0.113 | 39.91x | y |
| strTrim | 4000 | 0.934 | 0.035 | 26.54x | y |
| arrEvery | 5000 | 7.749 | 0.313 | 24.76x | y |
| allocObjects | 200000 | 3.223 | 0.134 | 24.13x | y |
| arrSome | 2000 | 27.685 | 1.157 | 23.93x | y |
| arrFind | 2000 | 14.531 | 0.619 | 23.46x | y |
| objLiteral | 200000 | 3.208 | 0.138 | 23.18x | y |
| objFieldRW | 200000 | 2.649 | 0.122 | 21.72x | y |
| strSlice | 4000 | 0.622 | 0.035 | 17.66x | y |
| strSubstring | 4000 | 0.625 | 0.036 | 17.25x | y |
| arrMap | 5000 | 2.313 | 0.156 | 14.80x | y |
| arrConcat | 2000 | 2.383 | 0.187 | 12.77x | y |
| strIndexOf | 3000 | 0.361 | 0.030 | 11.90x | y |
| strIncludes | 3000 | 0.359 | 0.030 | 11.81x | y |
| arrShift | 8000 | 2.657 | 0.229 | 11.62x | y |
| strEndsWith | 2000 | 0.205 | 0.020 | 10.11x | y |
| strTemplate | 100000 | 12.708 | 1.339 | 9.49x | y |
| strStartsWith | 2000 | 0.205 | 0.024 | 8.61x | y |
| arrSlice | 5000 | 0.227 | 0.029 | 7.73x | y |
| allocStrings | 100000 | 10.664 | 1.538 | 6.93x | y |
| arrPop | 20000 | 0.449 | 0.071 | 6.31x | y |
| arrPush | 20000 | 0.298 | 0.062 | 4.77x | y |
| strCharCodeAt | 3000 | 1.663 | 0.377 | 4.41x | y |
| arrSort | 2000 | 20.578 | 4.835 | 4.26x | y |
| mapIterate | 5000 | 0.947 | 0.223 | 4.24x | y |
| strCompare | 5000 | 1.892 | 0.459 | 4.12x | y |
| strStrToNum | 100000 | 10.178 | 2.955 | 3.44x | y |
| arrFilter | 5000 | 1.851 | 0.551 | 3.36x | y |
| objSpread | 200000 | 3.444 | 1.055 | 3.26x | y |
| arrIncludes | 2000 | 1.763 | 0.554 | 3.18x | y |
| strNumToStr | 100000 | 2.907 | 0.959 | 3.03x | y |
| strRepeat | 200 | 0.032 | 0.013 | 2.57x | y |
| mapGet | 20000 | 1.698 | 0.758 | 2.24x | y |
| arrForEach | 5000 | 0.860 | 0.392 | 2.20x | y |
| jsonParse | 2000 | 13.484 | 6.805 | 1.98x | y |
| arrReduce | 5000 | 0.906 | 0.458 | 1.98x | y |
| arrJoin | 5000 | 2.064 | 1.044 | 1.98x | y |
| arrIndexOf | 2000 | 0.562 | 0.299 | 1.88x | y |
| jsonStringify | 2000 | 5.637 | 3.249 | 1.74x | y |
| setAdd | 20000 | 0.490 | 0.309 | 1.58x | y |
| strJoin | 5000 | 3.495 | 2.206 | 1.58x | y |
| setHas | 20000 | 0.887 | 0.617 | 1.44x | y |
| strSplit | 3000 | 3.386 | 2.410 | 1.40x | y |
| numFloatMath | 10000 | 0.868 | 0.653 | 1.33x | y |
| numIntLoop | 10000 | 7.879 | 6.262 | 1.26x | y |
| mapHas | 20000 | 0.900 | 0.735 | 1.22x | y |
| arrSplice | 6000 | 0.771 | 0.643 | 1.20x | y |
| numMathCalls | 200000 | 1.555 | 1.475 | 1.05x | y |
| mapSet | 20000 | 0.677 | 0.651 | 1.04x | y |
| arrUnshift | 8000 | 2.448 | 2.497 | 0.98x | y |
| mapDelete | 20000 | 0.898 | 1.060 | 0.85x | y |
| arrReverse | 5000 | 0.208 | 0.389 | 0.53x | y |
