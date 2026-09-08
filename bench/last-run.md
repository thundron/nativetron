# nativetron vs Electron — equivalent desktop benchmark
host: darwin arm64   node: v24.15.0
electron: v44.0.0
date: 2026-09-08T00:36:00.292Z

| metric | nativetron | Electron | Electron / nativetron |
|---|---:|---:|---:|
| Shipped runtime | 0.5 MB | 286.7 MB | 524.4× |
| Warm launch → first frame (15-run median) | 166 ms | 227 ms | 1.4× |
| Warm launch → double-rAF confirmation | 229 ms | 236 ms | 1.0× |
| Process-tree steady RSS | 79,536 KB | 335,120 KB | 4.2× |
| Newly observed system WebKit RSS | 77,376 KB | 0 KB | — |
| Accounted steady RSS | 156,992 KB | 335,120 KB | 2.1× |
| Summed physical footprint | 87,328 KB | 126,769 KB | 1.5× |
| Child-tree processes | 2 | 4 | — |
| Steady CPU | 0.4% | 0.0% | — |

Aligned startup milestones from the parent timestamp:

| milestone | nativetron | Electron |
|---|---:|---:|
| Main process/runtime entered | 3 ms | 82 ms |
| Native application ready | 47 ms | 104 ms |
| Renderer code entered | 7 ms | 214 ms |
| Window created | 63 ms | 145 ms |
| Browser surface created | 95 ms | 145 ms |
| Document ready | 165 ms | 221 ms |
| Initial UI applied | 162 ms | 221 ms |
| First animation frame | 166 ms | 227 ms |
| Double-rAF confirmation | 229 ms | 236 ms |

_Startup uses 3 discarded warmups and alternating AB/BA order. Both apps render the same heading, copy, button, and reactive counter. Milestones are equivalent outcomes even where framework ordering differs. The paint marker is delivered after two animation frames. System WebKit attribution is the RSS of matching service processes first observed after nativetron launch; pre-existing or reused services remain a limitation._
