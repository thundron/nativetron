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
| interaction, median | 1.55 µs | 2.80 µs |
| interaction, p95 | 2.25 µs | 3.20 µs |
| payload, raw | 67 KB | 190 KB |
| payload, gzipped | 35 KB | 59 KB |
| 10k row update, median | 6.70 ms | 3.40 ms |
| 10k row mount, median of 5 | 84 ms | 16 ms |
| JS heap after 10k rows | 7.1 MB | 8.5 MB |

Mount splits about 40 ms guest / 36 ms host. The same 10k elements from plain
JS cost 5 ms via a fragment, 3 ms via `innerHTML`.

Update splits about 3 ms guest / 3.5 ms host. A 10k sort is 2.1 ms in wasm vs
0.4 ms in V8. Comparators that subtract a numeric key (`a.f - b.f`,
`k[a] - k[b]`) now inline: 14% off the sort, 2% off this benchmark.

## Canvas

See `canvas/`: 20000 rects per frame cost 1.81 ms compiled against 0.79 ms
from direct JS calls, subpixel-identical.

## Transport, per frame

5000 text updates, 60 fps budget 16.67 ms:

| lane | eval + apply | source |
|---|---|---|
| binary, base64 over eval (desktop) | 0.59 ms | 96 KB |
| JSON in source (removed) | 1.04 ms | 86 KB |

`bench/desktop-lane/`. Both lanes now carry the same binary batch; base64 is
faster because one long string literal parses cheaper than a nested array
literal.

## Against Electron

| metric | nativetron | electron 44 |
|---|---|---|
| shipped artifact | 1.01 MiB | 287 MB |
| cold start to first paint | 168 ms | 307 ms |
| peak resident memory | 75 MB | 330 MB |
| steady resident memory | 75 MB | 325 MB |
| processes | 1 | 4 |
| startup CPU | 8.0% | 20.6% |

Measured 2026-09-07 at scriptc `032123ab`: the bundle contains a 0.548 MiB main and 0.461 MiB renderer, or 1.01 MiB including its launcher and metadata. The increase from the earlier 0.55 MiB app is from the added desktop and compiled Pyrus workflows, not the 0.0.36 runtime update: rebuilding the same standalone JSX app changed it from 325,736 to 326,168 bytes. The current standalone JSX app is 0.311 MiB; the browser renderer is 61,984 bytes of wasm plus 2,682 bytes of loader glue.

Electron's helper processes are children and fully counted. The WKWebView
content process is spawned by the system, so nativetron's resident memory is
undercounted.
