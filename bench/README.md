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
| interaction, median | 1.65 µs | 3.45 µs |
| interaction, p95 | 2.55 µs | 3.70 µs |
| payload, raw | 363.4 KB | 189.7 KB |
| payload, gzipped | 140.7 KB | 59.3 KB |
| 10k row update, median | 3.50 ms | 3.70 ms |
| 10k row mount, median of 5 | 53 ms | 15 ms |
| JS heap after 10k rows | 1.95 MB | 16.57 MB |

The representative mount splits into 5.5 ms of data construction, 11.4 ms of guest DOM-batch encoding, 29.2 ms of host application, and about 7 ms of bridge and measurement overhead. Host DOM application remains the largest framework-owned mount cost. The final 10k update split is 1.5 ms guest / 2.2 ms host.

## Canvas

See `canvas/`: 20000 rects per frame cost 2.41 ms compiled against 1.123 ms
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
| benchmark binaries | 1.3 MB | 275.6 MB |
| warmed launch to first frame | 233 ms | 287 ms |
| double-rAF confirmation | 326 ms | 295 ms |
| process-tree steady RSS | 101.4 MiB | 361.0 MiB |
| system WebKit service RSS | 71.2 MiB | — |
| accounted steady RSS | 172.4 MiB | 361.0 MiB |
| summed physical footprint | 79.8 MiB | 93.1 MiB |
| application child tree | 2 processes | 4 processes |

Measured 2026-11-04 at scriptc `76dc1100e` with three discarded warmups, 15 alternating AB/BA startup rounds, and five alternating runtime rounds against Electron 42.11.18. Both applications render the same heading, paragraph, button, and reactive counter. Parent timestamps cover process creation through UI application and animation frames. Nativetron reaches the first frame 1.2× sooner; its initial second-frame interval makes double-rAF 31 ms slower.

The benchmark pair is a 569,000-byte main and an 814,344-byte renderer. The production sample is a 686,664-byte main and a 990,520-byte renderer; the JSX sample is 868,344 bytes. System WebKit content, network, and GPU services are not children; the runner attributes newly observed service processes separately. Summed RSS double-counts shared pages, so the report also measures physical footprint with macOS `footprint`.
