# Benchmarks

Both sides implement the same app: a heading, a paragraph, a button and a
counter. React 19, bundled with esbuild in production mode.

```sh
./bench/build-bench-apps.sh
TRIALS=100 node bench/run-web-runtime.mjs    # interaction latency
ROWS=10000 node bench/run-web-compute.mjs    # bulk update and mount
node bench/web-bench.mjs                     # payload size
./bench/build-desktop-app.sh
node bench/run-bench.mjs                     # desktop, against Electron
```

Electron is taken from `~/Library/Caches/electron` and extracted to a temporary
directory. It is not installed into the repository.

Mount is one cold sample per page load, so the runner uses fresh pages,
repeats, and alternates order. Only compare within one run.

## Against React

| metric | nativetron | react |
|---|---|---|
| interaction, median | 2.00 µs | 3.15 µs |
| interaction, p95 | 2.60 µs | 3.35 µs |
| payload, raw | 93.9 KB | 189.7 KB |
| payload, gzipped | 43.1 KB | 59.3 KB |
| 10k row update, representative median | 4.60 ms | 3.70 ms |
| 10k row mount, representative median of 15 | 63 ms | 12 ms |
| JS heap after 10k rows | 5.69 MB | 8.90 MB |

Repeated 15-mount runs placed nativetron between 60 and 70 ms. A representative run splits into about 8 ms of data construction, 17 ms of guest DOM-batch encoding, 34 ms of host application, and 4 ms of bridge and measurement overhead. Schema-bounded runs of homogeneous text elements reduce guest encoding time and wasm linear memory, but host DOM application remains the largest framework-owned mount cost. A 10k update splits about 3.1 ms guest / 1.8 ms host.

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
| benchmark binaries | 0.55 MiB | 287 MB |
| warmed launch to first frame | 166 ms | 227 ms |
| double-rAF confirmation | 229 ms | 236 ms |
| process-tree steady RSS | 79.5 MiB | 335.1 MiB |
| system WebKit service RSS | 77.4 MiB | — |
| accounted steady RSS | 157.0 MiB | 335.1 MiB |
| summed physical footprint | 87.3 MiB | 126.8 MiB |
| application child tree | 2 processes | 4 processes |

Measured 2026-09-08 at scriptc `032123ab` with three discarded warmups, 15 alternating AB/BA startup rounds, and five alternating runtime rounds. Both applications render the same heading, paragraph, button, and reactive counter. Parent timestamps cover process creation through UI application and animation frames. Nativetron reaches the first frame 1.4× sooner; its unusually long initial second-frame interval reduces the double-rAF advantage and remains under investigation.

The benchmark pair is 194,184 bytes of main code and about 379 KB of renderer code. The production sample remains a 239,816-byte main and approximately 482 KB renderer. System WebKit content, network, and GPU services are not children; the runner attributes newly observed service processes separately. Summed RSS double-counts shared pages, so the report also measures physical footprint with macOS `footprint`.
