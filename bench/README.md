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

Measurements interleave both stacks in one browser session. Absolute timings
track machine load closely — the same build measured 44 ms and 92 ms for a 10k
mount while a virtual machine was busy on another core — so run on mains power
with an otherwise idle machine, and only compare within one run.

## Against React

| metric | nativetron | react |
|---|---|---|
| interaction, median | 1.55 µs | 3.00 µs |
| interaction, p95 | 2.85 µs | 3.90 µs |
| payload, raw | 70 KB | 190 KB |
| payload, gzipped | 36 KB | 59 KB |
| 10k row update, median | 6.45 ms | 3.45 ms |
| 10k row mount | 44 ms | 15 ms |
| JS heap after 10k rows | 7.1 MB | 9.0 MB |

nativetron was faster in 60 of 60 interaction trials (sign test p < 0.001) and
slower in every bulk update trial.

Where the bulk time goes, for a 10k mount: about 19 ms in compiled guest code
building the batch, 15 ms in the host applying it, 4 ms fetching and
instantiating the module. Creating the same 10k elements directly from
JavaScript costs 5 ms with a fragment and 3 ms via `innerHTML`, so the host
still carries roughly 10 ms of decode overhead. The guest figure is inflated
because a mount runs once: the module is still in the engine's baseline
compiler and never gets hot enough to tier up.

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
