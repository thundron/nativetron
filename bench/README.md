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

Mount is one cold sample per page load, so the runner uses fresh pages,
repeats, and alternates order. Only compare within one run.

## Against React

| metric | nativetron | react |
|---|---|---|
| interaction, median | 1.65 µs | 2.90 µs |
| interaction, p95 | 2.25 µs | 3.50 µs |
| payload, raw | 70 KB | 190 KB |
| payload, gzipped | 36 KB | 59 KB |
| 10k row update, median | 6.45 ms | 3.55 ms |
| 10k row mount, median of 5 | 77 ms | 26 ms |
| JS heap after 10k rows | 7.1 MB | 8.5 MB |

Mount splits about 35 ms guest / 32 ms host. The same 10k elements from plain
JS cost 5 ms via a fragment, 3 ms via `innerHTML`.

Update splits about 3 ms guest / 3.5 ms host. A 10k sort is 2.1 ms in wasm vs
0.4 ms in V8; comparators other than the literal `a - b` are not inlined.

## Against Electron

| metric | nativetron | electron 44 |
|---|---|---|
| shipped artifact | 1.0 MB | 287 MB |
| cold start to first paint | 191 ms | 308 ms |
| peak resident memory | 75 MB | 332 MB |
| steady resident memory | 75 MB | 328 MB |
| processes | 1 | 4 |
| startup CPU | 8.5% | 29.8% |

Electron's helper processes are children and fully counted. The WKWebView
content process is spawned by the system, so nativetron's resident memory is
undercounted.
