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
| interaction, median | 2.05 µs | 3.20 µs |
| interaction, p95 | 2.70 µs | 3.55 µs |
| payload, raw | 91.2 KB | 189.7 KB |
| payload, gzipped | 42.4 KB | 59.3 KB |
| 10k row update, median | 4.70 ms | 3.70 ms |
| 10k row mount, median of 5 | 74 ms | 12 ms |
| JS heap after 10k rows | 6.81 MB | 10.52 MB |

Mount splits about 29 ms guest / 38 ms host. The same 10k elements from plain
JS cost 5 ms via a fragment, 3 ms via `innerHTML`.

A 10k sort is 2.1 ms in wasm vs 0.4 ms in V8. Comparators that subtract a numeric key (`a.f - b.f`,
`k[a] - k[b]`) now inline: 14% off the sort, 2% off this benchmark.

## Canvas

See `canvas/`: 20000 rects per frame cost 1.91 ms compiled against 0.83 ms
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
| shipped binaries | 0.69 MiB | 287 MB |
| cold start to first paint | 285 ms | 230 ms |
| peak resident memory | 98.1 MiB | 330.3 MiB |
| steady resident memory | 98.1 MiB | 326.2 MiB |
| processes | 2 | 4 |
| startup CPU | 13.7% | 23.5% |

Measured 2026-09-07 at scriptc `032123ab`. The benchmark launches the complete nativetron main/renderer pair and timestamps from the parent before process creation; the earlier renderer-only startup measurement was invalid. The shipped binaries are a 239,816-byte main and 481,512-byte renderer. The standalone JSX lifecycle app is 398,968 bytes; the browser renderer is 75,215 bytes of wasm plus 3,100 bytes of loader glue.

Electron's helper processes are children and fully counted. The WKWebView
content process is spawned by the system, so nativetron's resident memory is
undercounted.
