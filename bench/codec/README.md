# Codec comparison

Binary (the shipped wire format) against JSON tuples, measured on nativetron's
own pipeline over a real captured op stream: 10k rows mounted, then updated.

    cd bench/web-compute && node capture.mjs   # writes /tmp/mount.bin, /tmp/update.bin
    node bench/codec/compare.mjs

`compare.mjs` decodes the captured stream into neutral tuples, resolving interns
so the JSON form carries strings inline the way a JSON protocol must. Both
codecs then feed an identical apply path, so only the codec differs. The two
paths are asserted to produce the same tree before timing.

Encode is measured separately in the guest (compiled wasm), since that side has
no JS engine.

## Results

10k rows, medians of 21 (encode) and 15 (decode) interleaved runs.

| | binary | json | ratio |
|---|---:|---:|---|
| guest encode | 1.50 ms | 2.35 ms | binary 1.57x |
| mount wire | 347,785 B | 556,668 B | binary 1.60x |
| mount wire gzipped | 97,889 B | 115,030 B | binary 1.18x |
| mount decode only | 0.76 ms | 0.82 ms | binary 1.08x |
| mount decode+apply | 11.02 ms | 14.82 ms | binary 1.35x |
| update wire | 227,779 B | 342,229 B | binary 1.50x |
| update wire gzipped | 79,640 B | 84,086 B | binary 1.06x |
| update decode only | 0.74 ms | 0.61 ms | json 1.20x |
| update decode+apply | 2.51 ms | 2.17 ms | json 1.16x |

Binary is ahead on encode, on raw bytes, and on mount decode. JSON is ahead on
update decode. Gzipped, the wire difference is 1.06–1.18x.

The codec is a small lever on this workload. Building JSON in the guest costs
1.57x binary, not the order of magnitude that `strBuild` in `bench-survey`
suggests: that number is repeated concatenation, and array `push` + `join` is
not on that path.

The reason the JSON lane was removed is not throughput. The desktop transport
evals a base64 constant, and a JSON lane put data in evaluated source; see
`security/`.
