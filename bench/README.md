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

Measurements interleave both stacks in one browser session, and only numbers
from one run are comparable.

A mount can only be measured once per page load, which makes it the fragile
number here: it is a single cold sample, so it lands wherever the scheduler and
the clock speed happen to be. On Apple silicon an idle machine is the bad case
— a one-shot burst gets an efficiency core, while the same code under
background load runs on a boosted performance core and reads twice as fast. The
runner therefore mounts on fresh pages, repeats, and alternates which stack is
timed first, since whichever goes first otherwise absorbs the other page's load
work. The looped measurements (interaction, updates) are stable and need none
of this.

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

nativetron was faster in 100 of 100 interaction trials (sign test p < 0.001) and
slower in every bulk update trial.

Of a 10k mount, roughly 35 ms is compiled guest code building the batch and
32 ms is the host applying it. Creating the same 10k elements directly from
JavaScript costs 5 ms through a fragment and 3 ms through `innerHTML`, so most
of the host half is decode rather than DOM work. Both halves are cold: a mount
runs once, so neither the module nor the decode loop is ever hot enough to tier
up, which is why the gap is far wider here than on updates.

For updates the host half is about 3.5 ms — the whole of React's update — and
the rest is guest compute, most of it the sort. A 10k sort costs 2.1 ms in wasm
against V8's 0.4 ms, and a comparator that is not the literal `a - b` shape adds
another 1.7x because it is called through a closure instead of being inlined.

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
