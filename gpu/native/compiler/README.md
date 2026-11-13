# WGSL front-end compatibility: patched wgpu-native build

The official wgpu-native v29.0.1.1 prebuilt (`../wgpu-native.lock`) cannot compile the house-planner engine's shaders. It
fails on 24 of the 845 distinct pipelines the engine creates. Chrome (Tint) compiles all of them with no messages. The
failures come from two defects in Naga, the WGSL compiler inside wgpu. Both are open upstream, and neither has a
release fix.

| | blocker | where it fails | upstream |
|---|---|---|---|
| 1 | Naga has no WGSL §9.7 behavior analysis. A function with a return type whose body ends in a `loop` left only through `return` is rejected: "Returning None where Some(..) is expected". | shader module: 12 `gi.insert` variants (`insertKey`) | [gfx-rs/wgpu#9501](https://github.com/gfx-rs/wgpu/issues/9501) (open) |
| 2 | Override substitution treats expressions that use a `let` as constant expressions. `let c = CASCADE; … THETA[c + 1u]` (guarded, never runs for c = 4) gets evaluated and fails pipeline creation with InvalidAccessIndex. | compute pipeline: 12 `gi.merge#4` pipelines (CASCADE = 4) | [gfx-rs/wgpu#9002](https://github.com/gfx-rs/wgpu/issues/9002) (open; PR #10676 fixes a neighbouring case and leaves this one) |

Blocker 2 was not in the shader-lane report. Its own `results.json` records it ("Cannot access at the index" for
`gi.merge {"0":4}` in all three Naga back ends). It only shows up with the captured override constants: a probe run with
default constants passes.

The fix is two Naga patches (`patches/`), applied to the exact crate that wgpu-native v29.0.1.1 locks: naga 29.0.3,
with crates.io sha256 `0dd91265…098079`. The crate's `src/` is byte-identical to gfx-rs/wgpu@`4cbe6232` `naga/src`.
wgpu-native is then rebuilt from the pinned commit with those patches. The official prebuilt stays the default and the
baseline. No consumer source is changed, copied or special-cased: there are no shader labels and no string rewrites.

## The patches

### 0001: decide "missing return" with §9.7 behavior analysis

Naga marks every point where control can fall off the end of a function with a value-less `return`. The function that
does this, `proc::ensure_block_returns`, follows only the tails of `Block`, `If` and `Switch`. For a function with a
return type, the validator rejects that marker. A trailing `loop` always got the marker, whether or not the loop can
complete.

The patch adds `proc::block_behavior`, the §9.7 table applied to Naga IR:
- statement sequences, `if`, and `switch` (including multi-selector `fall_through` cases);
- `loop` with `continuing` and `break if`, including the special case where B1 = {Return};
- `break`, `continue` and `return`;
- `discard` = {Next};
- calls and plain statements = {Next}.

It returns `None` when the rules give some statement an empty behavior, or give `continuing` a Continue or Return. The
spec makes such programs invalid, so no conclusion is drawn from them.

The WGSL lowerer then decides as follows. If a function has a return type and its body's behavior is exactly {Return},
which is the spec's own condition for that function to be valid, every point where the old walk would add the marker
is unreachable. Each such point gets `return <zero value of the return type>` instead. Every other function is lowered
exactly as before.

The lowering preserves behaviors, which was checked in the parser and lowerer:
- `while` and `for` with a condition become `loop { if c {} else { break; } … }`, matching the spec's desugaring;
- `break if` becomes `Loop::break_if`;
- `case a, b:` becomes cases with `fall_through`;
- `discard` becomes `Kill`.

Soundness: if a tail block could complete normally, then so could each enclosing `Block`, `If` or non-fall-through
`Switch`, and therefore the body. That contradicts {Return}, so every tail block that receives the new statement is
unreachable.

Why a typed unreachable `return`, and not nothing:
- Every path in the IR of a non-void function keeps ending in a typed `return`, the invariant all back ends were
  written against.
- The MSL back end bounds every loop (`loop_bound`, to stop Metal from exploiting infinite-loop undefined behavior).
  That makes a WGSL-endless loop leavable in MSL. Without a `return` after the loop, control would then fall off the
  end of a non-void function, which is undefined behavior again.
- The SPIR-V back end already emits `OpReturnValue` with a null value at such a point.

Compatibility: void functions, and non-void functions that validated before, get exactly the statements they got
before. A value-less return in a non-void function always failed validation, so the patch only changes modules Naga
used to reject.

Diagnostics:
- Rejected programs keep the same marker, error and span.
- `compiler.test.mjs` checks that the probe's message, summary, line and column are byte-identical to the official
  build for four missing-return fixtures.

Legitimate infinite loops versus reachable missing returns:
- `loop {}`, `loop { continue; }` and `loop { discard; }` have an empty behavior. They prove nothing, and the function
  stays rejected, as before. The spec also rejects them.
- Loops with `break`, `break if`, `while` and `for` with a condition still have a reachable end, so they stay rejected.
- A `break` that leaves an inner `switch` or an inner `loop` does not leave the outer loop, so it does not make the end
  reachable. Functions with such a break are accepted.

### 0002: `let`-bound values stay runtime after override substitution

WGSL §8.1.2 says an expression is an override-expression only if every identifier in it resolves to an override or
const declaration (or a const function, type alias or struct). A `let` identifier makes the expression a runtime
expression (§8.16).

The WGSL lowerer already applies this with `force_non_const` on every `let` initializer. However,
`back::pipeline_constants::process_function`, which runs at pipeline creation, rebuilds expression kinds from scratch
after substituting the overrides, so it forgets which expressions were `let`s.

The IR keeps exactly one trace of a `let`: the WGSL front end records it in `named_expressions`. In functions, that map
otherwise holds only:
- function arguments, which are always runtime;
- phony `_ =` values, which have no users.

The GLSL and SPIR-V front ends never fill it. The patch marks each named expression non-const right after it is
evaluated. The initializer itself is still evaluated, so an override-expression initializer that fails (for example
`let d = 10u / O` with O = 0) still fails pipeline creation, as the spec requires. Expressions that use the `let` become
runtime expressions.

Expressions that really are override-expressions are unaffected. `A[O + 1u]` with O = 1 still fails pipeline creation,
in both builds; this is tested.

Behavior change for pipelines that worked before: an expression that depends on a `let` is no longer folded during
override substitution, in a module with overrides. A module without overrides was never folded. This matches what the
lowerer produces and what the spec says, and it is semantically equal: MSL still sees the override as a `constant`.
Naga's snapshot suite was rerun and none of its outputs changed (see Verification).

### Why not normalize WGSL before Naga

A source rewrite could fix blocker 1 by appending `return T();` to such functions. It would have to:
- re-implement WGSL parsing, scoping and §9.7 outside Naga;
- keep byte offsets for diagnostics;
- be maintained for every new syntax.

It is also exactly the per-function unreachable-`return` pattern the brief rules out. It cannot fix blocker 2 at all:
that defect sits in pipeline-time constant evaluation, after parsing. Rewriting `let` into `var` would change the
program's memory semantics and still be a guess.

The Naga patches are about 100 lines of logic plus tests, in the place where the spec rules belong. They apply to the
pinned source and can be sent upstream.

## Verification (this Mac: macOS 27.0.1, Apple M4 Max, Metal; correctness only, nothing timed)

**Naga unit tests (`cargo test --lib`, all front and back ends):** 136 pass, against 124 before the patches.

New tests:
- `front::wgsl::tests::behavior_analysis` (9 tests):
  - the §9.7 behavior table;
  - accepted and rejected functions;
  - unchanged IR for void functions and for functions that already validated;
  - the typed zero return.
- `back::pipeline_constants::let_bound_overrides` (3 tests).

With only the tests applied to unpatched Naga, 5 of the 8 WGSL-level behavior tests and 2 of the 3 override tests
fail, as expected. The ninth behavior test calls the new `block_behavior` function directly, so it cannot run there.

**Upstream Naga suite:** gfx-rs/wgpu@`4cbe6232`, `cargo test -p naga --all-features`, rerun with both patches. To
reproduce: fetch that commit, run `git apply --directory=naga patches/*.patch`, run the tests, then
`git status naga/tests/out`.
- Everything passes except `convert_snapshots_spv`, which needs the missing `spirv-as` tool and fails the same way
  without the patches.
- The snapshot test rewrites the outputs (636 of the 707 files under `naga/tests/out`): IR, analysis, MSL, SPIR-V,
  HLSL, GLSL and WGSL for all 286 WGSL inputs, including `overrides*.wgsl`. `git status` shows none of them changed.

**`compiler.test.mjs`:** generic fixtures in `fixtures/`, run through the real C API with both builds.
- The four missing-return fixtures are rejected identically by both builds.
- `behavior-unreachable-end.wgsl` is rejected by the official build. The patched build runs it on the GPU with
  correct results:
  - a 16-slot `atomicCompareExchangeWeak` hash insert whose loop is left only through `return`;
  - a `for (;;)` lookup;
  - unreachable ends in nested tails;
  - dead code after a `return`.
- `override-let-runtime.wgsl`:
  - The official build fails pipeline creation with InvalidAccessIndex (O = 1) or DivisionByZero (O = 0).
  - The patched build reads back `[99,20,1,10]` and `[20,10,0,10]`. The guarded access is skipped, and x / 0 = x.
- `override-expression-oob.wgsl` fails pipeline creation with O = 1 in both builds.

**Cross-check with Tint:** the fixtures were also run through the offline `tint` CLI that another lane built at Chrome
154's Dawn revision (`/tmp/nt-native-gpu-tint-20261113/bin/tint --format msl --validate [--overrides O=v]`).
Tint agrees with the patched build on every fixture:
- It accepts `behavior-unreachable-end.wgsl`, with only a "code is unreachable" warning for the deliberate dead code.
- It rejects the three missing-return fixtures with "missing return at end of function", and the empty loop with
  "loop does not exit".
- It accepts `override-let-runtime.wgsl` with O = 0 and O = 1.
- It rejects `override-expression-oob.wgsl` only with O = 1 ("index 2 out of bounds").

**`../probe.test.mjs` with the patched library:** passes static and dynamic. It covers caps, the CAS compute and render
readback proofs, 22 lifecycle checks, the CAMetalLayer surface, the shader diagnostics fixtures and the Swift import.
With the official library (the default) it also still passes.

**MSL difference for blocker 1** (`corpus/msl-diff.sh`): for all 12 `gi.insert` modules, the MSL that patched Naga
generates from the original source was compared with the MSL from the shader lane's hand-edited copy, which has
`return vec3u(INVALID, 0u, 0u);` after the loop. The two differ in exactly one line, the unreachable return value
(`metal::uint3 {}` versus `metal::uint3(4294967295u, 0u, 0u)`). The comparison used MSL 3.2, Restrict and loop
bounding, which is wgpu-hal's configuration.

### House-planner corpus (`corpus/corpus.mjs`)

The corpus is the 199 modules captured at runtime in `/tmp/nt-native-gpu-shaders-20261113`. It stays in `/tmp`, and
house-planner was not read or written.

`corpus/plan.mjs` turns the 8 scenario captures (1,347 pipeline creations) into 845 distinct descriptors. Each one is
replayed exactly:
- every one of the manifest's 429 entry points;
- 489 pipelines with override constants;
- explicit bind group layouts and pipeline layouts;
- vertex buffers, targets, blend, primitive and depth-stencil state.

Each runs on a device with the limits its scenario requested: `limits0` is the desktop 1 GiB pair; `limits1` is the
phone/core set. The existing `ntgpu-probe` also compiles every module, with layout "auto" and default constants.

| stage | official v29.0.1.1 | patched `naga-wgsl-compat.1` |
|---|---|---|
| probe: shader-module stage, 199 modules | 187 ok, 12 fail (`gi.insert`: "Function [68] 'insertKey' is invalid", 372:1) | **199 ok** |
| probe: compute pipelines, auto layout, default constants | 404/404 (the 12 failed modules have none) | **416/416** |
| replay: shader modules (199 × 2 limit sets) | 374/398 | **398/398** |
| replay: compute pipelines (Metal library + pipeline state) | 803/827 (12 module failures, 12 `gi.merge#4` InvalidAccessIndex) | **827/827** |
| replay: render pipelines (Metal) | 18/18 | **18/18** |
| uncaptured errors / device loss | 0 | 0 |

The 18 render pipelines are g-buffer (single- and double-sided), sun shadow, section cuts, lighting, glass tint, glass
reflection, glass g-buffer and tonemap. wgpu-hal builds the Metal library and the `MTLComputePipelineState` or
`MTLRenderPipelineState` synchronously inside pipeline creation, so a successful pipeline means Metal compiled it.

## Commands

```sh
gpu/native/compiler/build-patched-wgpu.sh            # build (≈30 s) or verify → prints the prefix
gpu/native/compiler/build-patched-wgpu.sh --offline  # verify only (no network)
gpu/native/fetch-deps.sh --variant patched           # same, through the shared entry point
gpu/native/build.sh --wgpu patched [--link dynamic]  # facade + probe against it → …/build/macos-arm64-<link>-naga-wgsl-compat.1/
NTGPU_WGPU_VARIANT=patched node gpu/native/probe.test.mjs
node gpu/native/compiler/compiler.test.mjs           # official vs patched, generic fixtures
node gpu/native/compiler/corpus/corpus.mjs --wgpu patched   # or official; results → /tmp/nt-native-gpu-compiler/<variant>/
gpu/native/compiler/corpus/msl-diff.sh DIR_A DIR_B
```

`NTGPU_WGPU_VARIANT=patched` selects the patched build for `fetch-deps.sh` and `build.sh`. Without it, everything uses
the official prebuilt, as before.

## Build, cache and provenance

- **Inputs**, pinned in `wgpu-native-patched.lock` and checked on every build:
  - the wgpu-native commit, from a git checkout. Its `Cargo.lock`, `ffi/wgpu.h`, `webgpu.h` and `webgpu.yml` digests
    must equal `../wgpu-native.lock`, and the checkout must be clean.
  - every crate, via `cargo fetch --locked`, which checks the lock checksums.
  - the naga `.crate` file's sha256.
  - each patch's sha256.
  - `rustc 1.97.1 (8bab26f4f 2026-07-14)`.
- **Toolchain:** upstream's release job used 1.91 (`rust-toolchain.toml` says 1.93). Neither is installed here, and
  installing one would be a global change. The script overrides `RUSTUP_TOOLCHAIN`, so rustup never installs anything.
  `NTGPU_RUSTC_ANY=1` allows another rustc, but the pinned output digests are then not checked.
- **Build:**
  - Same environment as upstream's macOS release job: `MACOSX_DEPLOYMENT_TARGET=10.13`, the
    `@rpath/libwgpu_native.dylib` install name, and `WGPU_NATIVE_VERSION=v29.0.1.1`, so `wgpuGetVersion` reports
    29.0.1.1.
  - Command: `cargo build --release --locked --offline`.
  - The Cargo.lock is upstream's minus naga's `source` and `checksum` lines (a path dependency), and the script asserts
    exactly that difference.
  - Paths to the cache, the build tree and the local rust-src are remapped. The libraries contain no `/tmp` or home
    directory paths.
- **Output digests:** two builds in different target directories produced identical libraries:
  - `libwgpu_native.a`: sha256 `7a3d459a…19a83`, 36,574,936 B.
  - `libwgpu_native.dylib`: sha256 `b4e59705…6e367`, 7,122,400 B.
  - These digests are pinned. The official ones are 34,356,312 B and 6,933,424 B. The static `ntgpu-probe` built
    against the patched library is 5,945,288 B, against 6,068,824 B for the official one.
- **Cache** (`$NT_NATIVE_GPU_DEPS`, default `/tmp/nt-native-gpu-deps`; one canonical copy, never inside a worktree):

  | path | contents |
  |---|---|
  | `src/wgpu-native-6aed50955d93/` | pristine checkout |
  | `src/wgpu-native-v29.0.1.1+naga-wgsl-compat.1/` | build tree, with the patched `naga/` |
  | `cargo-home/` | downloaded crates |
  | `build/cargo-target-v29.0.1.1+naga-wgsl-compat.1/` | cargo target directory; can be deleted |
  | `wgpu-native/v29.0.1.1+naga-wgsl-compat.1/macos-aarch64-release/` | the installed prefix |

  The installed prefix has the same layout as the official one. Its `provenance/` holds:
  - `PROVENANCE.txt` and `BUILD-INFO.txt`;
  - `Cargo.lock` and `Cargo.lock.diff`;
  - the patches;
  - `rustc-version`;
  - licences: wgpu-native and naga are MIT OR Apache-2.0, webgpu-headers is BSD-3-Clause;
  - `SHA256SUMS`, re-checked on every use.

  The official prefix and archive are untouched.
- **Licences:** the patches are original work and are offered under naga's licence (MIT OR Apache-2.0). Third-party
  notices for the roughly 140 statically linked crates are still not generated, as with the official build.

## Remaining gaps

- **Naga still does not reject everything §9.7 rejects.** This is unchanged by the patches and does not affect the
  corpus. Naga still accepts:
  - `loop {}` in void functions;
  - a non-void function whose tail is `discard;`, or a `switch` whose case ends in `break`.
- **Naga's validator still rejects a constant out-of-range index that reaches an access through a `let` at
  shader-module time.** An example is `let i = 5u; a4[i]` in dead code ([#4390](https://github.com/gfx-rs/wgpu/issues/4390),
  open PR #10676). It is not in the corpus.
- **Only macOS arm64 is built and verified.** The other targets need the same source build.
- **Tint comparison:** for the corpus, the reference is Chrome's runtime Tint; the offline Tint was used only for the
  fixtures above. Dawn is not built.
- **Corpus coverage:** the corpus covers one scene. The GI kernels bake layout-dependent constants, so new layouts
  produce new modules. Their shapes are covered, but not every possible value.
