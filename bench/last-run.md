# nativetron vs Electron — equivalent desktop benchmark
host: darwin arm64   node: v24.22.1
electron: v42.11.18
date: 2026-11-04T12:06:07.345Z

| metric | nativetron | Electron | Electron / nativetron |
|---|---:|---:|---:|
| Shipped runtime | 1.3 MB | 275.6 MB | 208.9× |
| Warm launch → first frame (15-run median) | 233 ms | 287 ms | 1.2× |
| Warm launch → double-rAF confirmation | 326 ms | 295 ms | 0.9× |
| Process-tree steady RSS | 103,808 KB | 369,664 KB | 3.6× |
| Newly observed system WebKit RSS | 72,864 KB | 0 KB | — |
| Accounted steady RSS | 176,512 KB | 369,664 KB | 2.1× |
| Summed physical footprint | 81,745 KB | 95,361 KB | 1.2× |
| Child-tree processes | 2 | 4 | — |
| Steady CPU | 0.3% | 0.0% | — |

Aligned startup milestones from the parent timestamp:

| milestone | nativetron | Electron |
|---|---:|---:|
| Main process/runtime entered | 3 ms | 107 ms |
| Native application ready | 63 ms | 143 ms |
| Renderer code entered | 8 ms | 273 ms |
| Window created | 84 ms | 214 ms |
| Browser surface created | 124 ms | 214 ms |
| Document ready | 231 ms | 281 ms |
| Initial UI applied | 229 ms | 281 ms |
| First animation frame | 233 ms | 287 ms |
| Double-rAF confirmation | 326 ms | 295 ms |

_Startup uses 3 discarded warmups and alternating AB/BA order. Both apps render the same heading, copy, button, and reactive counter. Milestones are equivalent outcomes even where framework ordering differs. The paint marker is delivered after two animation frames. System WebKit attribution is the RSS of matching service processes first observed after nativetron launch; pre-existing or reused services remain a limitation._
