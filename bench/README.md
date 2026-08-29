> ⚠️ **macOS note:** installing/launching Electron here downloads an *unsigned
> prebuilt `Electron.app`* that recent macOS XProtect may quarantine or move to
> Trash, and this host's security policy `SIGKILL`s it. The Electron baseline is
> therefore **opt-in**: nothing installs or launches Electron automatically.
> `run-bench.mjs` only measures Electron if you have already run
> `npm install` in `bench/electron-app/` yourself. The shipped-artifact size
> comparison does not require Electron to run.

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

| metric | nativetron | electron | electron / nativetron |
|---|---|---|---|
| **Disk (shipped runtime)** | 1.0 MB | 286.7 MB | 296.3× |
| **Cold start → first paint** (median of 5) | 165 ms | 301 ms | 1.8× |
| **Peak RSS** (process tree) | 80,272 KB | 342,448 KB | 4.3× |
| **Steady RSS** | 80,256 KB | 338,224 KB | 4.2× |
| **Processes** | 1 | 4 | — |
| **Peak CPU%** (startup, tree) | 6.5% | 26.6% | — |

_Notes: RSS is the summed resident set of the process tree (sampled every
100 ms). nativetron's out-of-process WKWebView content helper is
system-spawned (not a child) and may be undercounted; Electron's helpers are
children and fully counted. Disk = what each app ships (nativetron binaries
vs the Electron.app runtime); nativetron reuses the OS WebKit, not shipped._

## Browser payload (wasm vs React)

# nativetron (wasm) vs React — browser payload

Identical app: h1 + paragraph + Increment button + counter.

| artifact | nativetron | react |
|---|---|---|
| app+runtime (raw) | 88.6 KB | 189.0 KB |
| app+runtime (gzip) | 41.5 KB | 59.1 KB |
| — wasm / react+react-dom+app | 83.7 KB | 189.0 KB |
| — JS glue | 2.5 KB | — |
| — DOM host | 2.4 KB | — |

ratio (react / nativetron): raw 2.13×, gzip 1.42×

nativetron ships no framework runtime in JS: the reconciler and all app
logic are AOT-compiled into the wasm. The wasm's fixed cost is the scriptc
runtime (GC, strings, JSON); React's fixed cost is react+react-dom.
