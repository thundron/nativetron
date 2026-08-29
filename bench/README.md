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
| interaction, median | 1.55 µs | 2.90 µs |
| interaction, p95 | 2.05 µs | 3.40 µs |
| interaction, worst of 100 trials | 4.30 µs | 4.80 µs |
| payload, raw | 70 KB | 190 KB |
| payload, gzipped | 36 KB | 59 KB |
| 10k row update, median | 6.50 ms | 3.50 ms |
| 10k row mount | 105 ms | 14 ms |
| JS heap after 10k rows | 7.1 MB | 9.0 MB |

nativetron was faster in 100 of 100 interaction trials (sign test p < 0.001) and
slower in all 30 bulk update trials.

## Against Electron

| metric | nativetron | electron 44 |
|---|---|---|
| shipped artifact | 1.0 MB | 287 MB |
| cold start to first paint | 182 ms | 310 ms |
| peak resident memory | 76 MB | 331 MB |
| steady resident memory | 76 MB | 327 MB |
| processes | 1 | 4 |
| startup CPU | 8.0% | 22.4% |

Electron's helper processes are children and fully counted. The WKWebView
content process is spawned by the system, so nativetron's resident memory is
undercounted.
