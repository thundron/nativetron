# Benchmarks

Both sides implement the same app: a heading, a paragraph, a button and a
counter. React 19, bundled with esbuild in production mode.

```sh
./bench/build-bench-apps.sh
TRIALS=100 node bench/run-web-runtime.mjs    # interaction latency
ROWS=10000 node bench/run-web-compute.mjs    # bulk update and mount
node bench/web-bench.mjs                     # payload size
node bench/run-bench.mjs                     # desktop, against Electron
```

Electron is taken from `~/Library/Caches/electron` and extracted to a temporary
directory. It is not installed into the repository.

Measurements interleave both stacks in one browser session. Results on battery
vary by up to 27%, so run on mains power.

## Against React

| metric | nativetron | react |
|---|---|---|
| interaction, median | 1.50 µs | 2.85 µs |
| interaction, worst of 100 trials | 3.95 µs | 4.60 µs |
| payload, raw | 67 KB | 190 KB |
| payload, gzipped | 35 KB | 59 KB |
| 10k row update | 6.45 ms | 3.50 ms |
| 10k row mount | 89 ms | 12 ms |

## Against Electron

| metric | nativetron | electron 44 |
|---|---|---|
| shipped artifact | 1.0 MB | 287 MB |
| cold start to first paint | 165 ms | 305 ms |
| peak resident memory | 81 MB | 343 MB |
| processes | 1 | 4 |
| startup CPU | 7.8% | 31.4% |
