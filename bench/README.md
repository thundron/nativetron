# nativetron vs Electron — benchmark harness

A minimal, honest comparison between the nativetron Phase 0 demo (TypeScript
AOT-compiled to native machine code, driving the system WKWebView) and a
functionally equivalent **Electron** app (Chromium + V8 + Node runtime).

Both apps do the same thing: open a ~520×360 window showing an `<h1>Hello</h1>`
and a button that increments a counter shown in the renderer. The difference the
benchmark exposes is *what each stack costs to ship and to start* — not paint
speed (both ultimately draw with a system/Chromium web engine).

## Layout

```
bench/
  electron-app/         minimal Electron baseline (equivalent demo)
    package.json        electron as a devDependency
    main.js             BrowserWindow -> index.html
    index.html          <h1>Hello</h1> + button + counter
    renderer.js         counter state/handler in page JS (V8) — the Electron model
    node_modules/       (gitignored; ~236 MB Electron runtime download)
  run-bench.mjs         measures both apps, prints a Markdown table
  .gitignore            ignores electron-app/node_modules
  README.md             this file
```

## How to run

```sh
# 1. Build nativetron (from the repo root):
SCRIPTC=/path/to/scriptc/packages/cli/dist/main.js ./build.sh
#    -> build/main, build/renderer (native arm64), native/nativetron_core.o

# 2. Install the Electron baseline runtime:
cd bench/electron-app && npm install
#    If the postinstall binary download is skipped, force it:
#      node node_modules/electron/install.js

# 3. Run the harness (from the repo root):
node bench/run-bench.mjs
```

`run-bench.mjs` self-heals the Electron runtime: if `node_modules/electron/dist`
is missing it re-extracts it via Electron's own `install.js` before measuring.

## What each number means (and its caveats)

### 1. Artifact size shipped — **fully measurable, the headline result**

This is the "what actually ships to a user" comparison.

- **nativetron** = `build/main` + `build/renderer` + `native/nativetron_core.o`.
  These are the native arm64 executables plus the compiled C++ webview-wrapper
  object. The vendored [`webview`](https://github.com/webview/webview) library is
  **header-only** and is compiled *into* the renderer, so its cost is already
  inside those bytes. nativetron does **not** ship a browser engine — it reuses
  the OS's WKWebView, which is not counted (it's part of macOS).
- **Electron** = `node_modules/electron/dist` — the Chromium + V8 + Node runtime
  that every Electron app bundles and ships. This is the fair "runtime you must
  distribute" figure. (Your own `main.js`/`index.html` are a few KB and
  negligible next to the runtime.)

Reported as block-usage on disk (`du -sk`), so it reflects real footprint.

Caveat: a *packaged* Electron app (electron-builder, asar, pruned locales) can
trim the runtime somewhat, and nativetron's binaries are unstripped/-O2. The
order-of-magnitude gap (hundreds of MB vs ~1 MB) is the robust takeaway, not the
exact ratio.

### 2. Cold-start RSS + process/thread counts — **measurable for nativetron only on this host**

The harness launches each app, walks the **entire process tree** (root + all
descendants) via `ps -axo pid,ppid,rss`, sums resident set size every 100 ms for
up to 3 s, and records peak RSS, steady RSS (median of the last third of
samples), peak process count, and peak thread count (`ps -M`). It then tears the
whole tree down.

It is deliberately honest about launches that do not produce a normal running
process:

- **exits immediately** → reported as `not measured (exited …)`.
- **killed by a signal** → reported as `not measured (killed by SIG… )`.
- **starts but never initializes** (a GUI runtime that stays a single tiny
  process and never spawns its renderer/GPU children) → reported as
  `not measured (runtime did not initialize …)` rather than a bogus ~0 MB.

**On this machine, Electron could not be runtime-measured** (see RESULTS): the
ad-hoc-signed Electron binary is `SIGKILL`ed by the host's security policy on
launch (and its `Electron.app` bundle is subsequently deleted from disk — the
harness re-extracts it before each size measurement). nativetron's native
binaries are not subject to this and run normally, so their RSS/process/thread
figures are real.

Caveat: this is a **headless, non-interactive shell with no attached window
server session**. nativetron's WKWebView still initializes here (its renderer
resident set is real), but you should treat these as environment-specific
cold-start numbers, not polished product benchmarks. A representative running
Electron app on macOS would be **4–5 processes and ~100–300 MB RSS** — dwarfing
nativetron's tree — but we do not print an invented figure for it.

## RESULTS (actual output on this machine)

Host: `Darwin arm64`, Node `v24.19.0`. Electron `31.7.7`. Electron **installed
successfully** (npm metadata + the ~236 MB runtime binary extracted). Verbatim
`node bench/run-bench.mjs` output:

```
# nativetron vs Electron — benchmark run
host: Darwin arm64  node: v24.19.0
time: 2026-08-29T20:17:30.272Z

## launching nativetron (./build/main)…
   peakRSS=78656KB steadyRSS=72624KB procs=2 threads=15

## launching Electron (runtime present)…
   outcome: killed by SIGKILL after ~2.3s

## Results

| metric | nativetron | electron | ratio |
|---|---|---|---|
| **Artifact size shipped** | 990.3 KB (1,014,080 B) | 235.7 MB (247,181,312 B) | 244× (Electron / nativetron) |
|   — main | 390.2 KB (399,592 B) | (inside runtime) | — |
|   — renderer | 483.5 KB (495,064 B) | (inside runtime) | — |
|   — native core .o | 116.6 KB (119,424 B) | (inside runtime) | — |
| **Peak tree RSS** | 76.8 MB (78,656 KB) | n/a | n/a |
| **Steady tree RSS** | 70.9 MB (72,624 KB) | n/a | n/a |
| **Peak process count** | 2 | n/a | — |
| **Peak thread count** | 15 | n/a | — |
| **Launch outcome** | ran, sampled | not measured (killed by SIGKILL after ~2.3s) | — |

### Notes
- Electron runtime: re-extracted.
- Electron launch: killed by SIGKILL after ~2.3s.
- "Artifact size shipped" is block-usage on disk. The vendored webview is header-only and compiled into the renderer, so it is already inside those bytes; nativetron reuses the OS WKWebView (not shipped). Electron ships its own Chromium+V8 (node_modules/electron/dist).
- RSS is the summed resident set of the whole process tree, sampled every 100ms for up to 3s.
```

### Reading the results

- **Artifact size — the clean, robust win:** nativetron ships **~990 KB**
  (main + renderer + native core) versus Electron's **~236 MB** bundled runtime
  — a **~244×** difference. This is the number to trust from this environment.
- **nativetron cold start (real):** a **2-process** tree (compiled `main` spawns
  the compiled `renderer`), **~76 MB peak / ~71 MB steady RSS**, **15 threads**.
  Almost all of that RSS is the **OS WKWebView / WebKit** that the renderer
  brings up — nativetron's own compiled code is a small slice (the `main`
  process alone is ~1.4 MB RSS; the ~76 MB is WebKit resident memory). This is
  the honest framing from ARCHITECTURE.md: pixels are still a system web engine.
- **Electron runtime — not measured here:** the unsigned/ad-hoc Electron binary
  is `SIGKILL`ed by this host's security policy on launch (across repeated runs
  it was observed either killed outright, or held as a suspended single 32 KB
  process that never spawned Chromium's GPU/renderer children — never a real
  running tree). The harness reports these as `n/a` rather than inventing a
  number. On an unrestricted macOS desktop, Electron would show ~4–5 processes
  and ~100–300 MB RSS — i.e. the RSS gap would also favor nativetron, but that
  figure is **not** something this machine could measure, so it is left `n/a`.

## Honest summary

| What | Measured here? | Result |
|---|---|---|
| Ship size (disk) | ✅ both | nativetron ~990 KB vs Electron ~236 MB (~244×) |
| Cold-start RSS | ✅ nativetron only | ~76 MB peak (mostly OS WebKit); Electron n/a (SIGKILLed by host) |
| Process/thread count | ✅ nativetron only | 2 procs / 15 threads; Electron n/a |
| Paint / layout speed | ❌ (headless) | out of scope — both use a system web engine |

The defensible, reproduced-on-this-machine claim is the **~244× smaller shipped
artifact**. The startup/RSS/process-count wins are directionally supported by
nativetron's real 2-process / ~76 MB tree, but the Electron side of those rows
could not be measured in this locked-down headless environment and is honestly
marked `n/a`.
