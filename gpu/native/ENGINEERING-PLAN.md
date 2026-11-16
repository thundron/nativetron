# Engineering plan: native rendering after the feasibility spike

Status: draft for architectural decisions, not authorization to implement every proposal. No renderer, language, or UI migration is selected by this document. Effort and schedule are not used to rule out a technically better architecture.

## Recommendation

Run two lines of work: diagnose the current stack with controlled experiments, and build an independent direct-Metal vertical slice that can challenge it. In parallel, prove a public native-viewport composition model. Use the results to choose between repairing wgpu-native and moving rendering into a native renderer service with its own render graph.

A new renderer or Zig implementation is a legitimate option. Neither should be justified by the word native: Chrome already executes native Metal work, and our existing native CPU reactor barely changes GPU-bound frame latency. Select architecture, shader generation, scheduling, and language as separate decisions.

The most promising long-term candidate is a native renderer service that owns scene resources, frame scheduling, and GPU completion, with a native viewport and web UI panels. The application can remain TypeScript. A direct Metal implementation, a Zig core, hardware ray queries, and a different rendering algorithm are independently selectable parts of that design.

## Evidence and limits

The current [feasibility result](FEASIBILITY.md) and [raw measurement report](benchmark/RESULTS.md) are the baseline, not a proof that native rendering is inherently slower.

| Current path | Stationary-camera redraw, ms/frame | Moving-camera work, ms/frame |
| --- | --- | --- |
| Chrome, Wasm reactor, Dawn/Metal | 3.92 | 15.23 |
| WK Wasm reactor, native wire, wgpu-native/Metal | 8.10 | 21.20 |
| Native reactor, same native executor, CLI | 6.13 | 21.32 |
| Wasm reactor, same native executor, CLI | 6.16 | 21.45 |

These are GPU-completed work-frame latencies, not display FPS or still-image export times. The CLI is a different harness and is not an exact subtraction experiment for WebView transport. Still, the moving-frame deficit persists without the page and wire, so a WebView-only fix is unlikely to recover the entire gap.

System GPU-accounting counters report approximately 12.00 ms/frame in Chrome versus 15.85 ms/frame in WK-to-native during moving phases. That supports investigating backend execution, shader generation, and resource transitions. It does not identify which shader is responsible. Existing per-pass timestamps overlap on the tile-based GPU and are not a reliable optimization map.

The reported 0.73 ms moving-frame submit cost is time inside the executor, not end-to-end IPC latency. Only about 10.9 KB of request bodies crosses upstream per moving frame, so bandwidth alone is an implausible explanation for a six-millisecond deficit. Scheduling, validation, synchronization, and delivery latency remain candidates.

Other qualifications matter: the full app never reported STATUS_SETTLED, native stationary-frame results were variable, background GPU workloads required exclusions, and a paired Low Power Mode run was blocked by administrator permission. Preserve these limitations in every comparison.

## Constraints and decisions to revisit explicitly

- Keep the current JS WebGPU path usable while alternatives develop. Preserve protocol 3 for compatible executors; negotiate any new scene, graph, or ray-tracing API separately rather than silently changing its meaning.
- House-planner remains read-only. Capture fixtures and run sandbox copies. A future consumer integration or UI redesign requires its owner's approval; nativetron must not hard-code the consumer's GI or material implementation.
- No Dawn runtime is currently approved. The existing browser baseline may internally use Dawn. Offline Tint was used as a validation tool; shipping Tint or embedding Chromium is a separate dependency decision, not permission implied by that test.
- A public composition path is the proposed production baseline. If the owner accepts private API use for controlled distribution, document that policy, runtime guards, and release risk explicitly. Do not make the experimental drawsBackground underlay an invisible dependency.
- Do not exchange correctness, quality, or safety for an unqualified benchmark win. Intentional algorithm or quality changes need their own acceptance criteria.
- Native failure must not poison the entire application. Reactor poisoning and aborting backend entry points require an isolation and recovery design.

## Proposal A: repair the existing native execution path

### Mechanism

Keep WGSL, the guest API, and wgpu-native. Remove avoidable completion latency and identify where the backend creates more GPU work than Chrome. This is the lowest architectural-disruption option, not an assumption that incremental work must win.

### Experiments

1. Trace one frame from guest encoding through owned-copy completion, native arrival, decode/validation, queue submission, GPU completion, Worker delivery, and guest completion. Record bytes, queue depth, fences, wakeups, and event order. Use a single clock for round trips or explicitly calibrate cross-process clocks.
2. Sweep pending-work polling intervals while preserving zero idle polling. Compare the current 250 microsecond to 2 ms backoff against fixed shorter intervals and an event-driven wakeup experiment. Measure CPU and energy as well as latency. Do not restore the blocking device poll that holds a fence lock against queue submission.
3. Investigate a backend completion hook that wakes the owner when the driver completes work, then drains wgpu callbacks without a permanent timer. Keep GPU completion distinct from CPU consumption and keep callback delivery outside guest exports.
4. Use Metal tracing to inspect submission gaps, synchronization, encoder boundaries, resource transitions, and shader execution. Test any validation or pooling optimization with malformed inputs and device loss; do not disable safety checks to obtain a favorable result.
5. Investigate pipeline creation and cache keys separately from steady-state rendering. Stable module/layout hashes, a critical-first pipeline schedule, and asynchronous compilation can improve first usable image without changing frame throughput. Do not call a lower-quality first frame equivalent to the baseline.

### Decision

Continue this path if isolated fixes close the measured application gap while preserving power behavior, recovery, and portability. If the native executor remains slower on identical commands after completion overhead is controlled, stop attributing the problem to IPC and advance the direct-Metal comparison.

## Proposal B: direct Metal executor, with an optional Zig core

### Mechanism

Implement an independent Metal executor behind a stable host-facing interface. Initially consume the same recorded commands, buffers, layouts, and shaders as the existing executor. This separates execution API costs from a new rendering algorithm.

Start with Swift or Objective-C++ at the Apple API boundary. A portable core can be C++, Rust, or Zig. A Zig core with a thin Objective-C++ or Swift shim is a credible design: explicit allocation and ownership, a C ABI, a native build, and potential browser-Wasm reuse. It is not evidence of faster Metal shaders.

### Vertical slice

- Reproduce a real opaque-plus-transparent scene slice, resource uploads, resize, capture, and completion. Do not use only an empty triangle or shader compilation as the comparison.
- Preserve the protocol's resource types, generation retirement, row padding, color/alpha conventions, asynchronous events, and bounded queues. The same command stream must mean the same work.
- Begin with tracked Metal hazards and a straightforward implementation. Introduce heap aliasing, untracked hazards, or pass merging only after explicit dependency analysis and validation.
- Add real pipeline caches and Metal binary archives with keys that include source, constants, layouts, device/OS compatibility, and compiler options. A metallib does not eliminate every runtime pipeline-compilation cost.

### Separate frontend from executor

Run controlled comparisons with the same resource bindings and compiler options:

| Comparison | What it can isolate |
| --- | --- |
| Naga-generated MSL versus Tint-generated MSL, both in the direct Metal harness | Shader translation differences |
| The same Naga-generated MSL and matched pipeline settings under direct Metal versus the existing backend | Execution, pass management, or synchronization differences |
| C++ core versus Zig core under the same Metal shim, shaders, and command tape | CPU dispatch, allocation, and integration costs |

Do not assume wgpu-native's public C API accepts arbitrary MSL. A Tint-to-SPIR-V-to-Naga path is not the same experiment as running Tint-generated MSL. Prove access to the exact generated shader, binding map, specialization values, and compiler options before claiming frontend isolation.

### Shader strategy

Keep WGSL as the reference while evaluating offline MSL compilation. Current shaders include scene-dependent generated constants, so offline compilation requires either finite specialization families or a redesign that moves suitable values into uniforms, storage, or pipeline constants. Measure any optimization lost by making values dynamic.

Consider Slang or another shared shader-source toolchain only after proving the required MSL and browser-WGSL paths, atomics, layouts, overrides, and diagnostics on the actual corpus. A new shader language must not quietly abandon browser support. Alternatively, maintain a small, tested MSL specialization for measured hot kernels and retain WGSL elsewhere; avoid duplicating the entire shader library by default.

### Decision

Select direct Metal if it produces a repeatable application or energy advantage and can support the required lifecycle and shader toolchain. Retain a portable WebGPU backend for browsers and other targets. A Metal win does not establish a Vulkan or DX12 win.

## Proposal C: renderer service and render graph

### Mechanism

Move ownership of rendering from a page-driven sequence of GPU calls into a renderer service. The application publishes scene changes, camera state, quality policy, and capture requests. The service owns persistent resources, pass dependencies, frame scheduling, refinement, and GPU completion.

```text
TypeScript application / UI
        |
versioned scene deltas, input, captures, status
        |
renderer service + render graph
        |
Metal | portable WebGPU | future Vulkan/DX12
```

A graph can expose attachment lifetimes, memory reuse, pass fusion opportunities, and data hazards that an imperative WebGPU-compatible executor cannot freely reinterpret. It can also keep refinement and presentation scheduling out of per-frame Worker request/response cycles. Current traffic is already small; the proposed benefit is ownership and scheduling, not a claim that large per-frame scene copies are the bottleneck.

### Contracts

- Keep application document/model state authoritative outside the renderer. Publish versioned immutable snapshots and bounded deltas with recoverable resource IDs, not native pointers.
- Separate scene/material semantics from backend resource and pass APIs. Keep any reusable 3D renderer an optional module; nativetron's host must not become house-planner-specific.
- Define camera updates as coalescible state, scene edits as ordered reliable changes, and assets/captures as bounded bulk. Do not coalesce commands whose effects must occur.
- Define interactive frames, refinement progress, and final export quality separately. A camera frame must not wait for all background GI work, and an export must not silently accept the interactive approximation.
- Cache shader variants and pipeline objects against explicit scene/layout/quality versions. The graph may not alias resources until the GPU has completed every conflicting use.

### Isolation and presentation

A production renderer service can own both the native reactor and GPU backend in a supervised process. On failure, recreate the process and replay authoritative state. Bound retries and report repeated failure instead of restarting forever.

GPU images cannot cross a process boundary as CAMetalLayer pointers. An Apple implementation needs a supported shared-image mechanism such as IOSurface, a bounded image lease ring, and cross-process GPU synchronization. Measure the required copy or blit. wgpu-native does not automatically expose every native import/export capability; a backend extension or direct Metal path may be necessary.

### Decision

Choose this architecture if it improves scheduling, failure isolation, resource reuse, or future native rendering capabilities enough to justify a new scene/rendering contract. Keep the legacy protocol adapter for existing consumers. Do not claim that introducing a graph alone makes existing kernels faster.

## Proposal D: a new hybrid renderer

A new renderer can have a larger GPU impact than changing the CPU language. Explore these candidates only after profiling identifies the dominant cost, and evaluate each at equal visual quality.

### Hardware ray-query lighting and reflections

Keep rasterization for primary visibility and replace software BVH traversal with native acceleration structures and ray queries where the device supports them. Preserve instancing and incremental transform updates; measure acceleration-structure build/refit latency and memory as well as ray time.

This is attractive if intersections dominate the measured workload. It will not solve expensive material evaluation, bandwidth, or postprocessing by itself. Protocol 3 does not provide this renderer contract. Add an explicitly negotiated renderer capability or a new API; do not disguise acceleration structures as existing buffers. Browser and unsupported-device paths need a software traversal fallback.

### Tile-aware deferred, clustered forward, or visibility-buffer rendering

Test whether the Apple GPU is spending time moving full-resolution intermediate buffers rather than doing useful shading. A native Metal design can evaluate tile-local/imageblock techniques and suitable transient attachments, subject to device support. Clustered forward rendering may reduce intermediate bandwidth; a visibility buffer may replace several attributes with IDs plus reconstruction work.

These are alternatives to benchmark, not a prescribed winner. Glass, alpha testing, reflections, GI consumers of G-buffer data, and transparency ordering can erase the apparent savings. Keep a separate and correct transparency strategy and profile material-heavy and glass-heavy scenes, not only opaque geometry.

### GPU-driven visibility and persistent scene data

Keep mesh/material/instance data resident, apply incremental updates, and investigate GPU culling and indirect command generation. This is most relevant if larger scenes reveal draw/submission or visibility costs. The current small command stream and GPU-bound result do not establish that draw-call reduction is the first priority.

### New GI and interaction-quality policy

Evaluate temporal reuse, better sample allocation, reservoir-based lighting methods, and separate camera/refinement budgets if the existing GI dominates. Dynamic resolution with temporal reconstruction is also an option for interaction, provided exports retain their required resolution and quality.

These change the rendering algorithm or quality contract. Compare convergence, disocclusion, thin-wall leakage, small bright lights, glass, mirrors, temporal ghosting, and determinism against a reference. A faster low-resolution or lower-sample result must not be reported as a backend speedup. Do not import a large engine's entire renderer merely to obtain one technique.

### Concrete new-renderer challenger: R1

R1 is a coherent replacement to evaluate, rather than a collection of unrelated optimizations:

- Keep the document, CAD operations, and application policy in TypeScript. Publish a versioned render scene rather than executing a browser-style GPU program from the UI.
- Put persistent meshes, materials, instance transforms, acceleration structures, and the render graph in a native service. A Zig core with an Apple API shim is one implementation candidate; C++ is the control implementation.
- Use rasterization for primary visibility. Compare a tile-aware clustered path with the existing deferred path before selecting its buffer layout.
- Use hardware ray queries, where available, for the measured intersection-heavy parts of direct light, reflections, and GI visibility. Initially retain the established GI representation and material evaluation so a traversal change can be validated independently.
- Render glass/transparency explicitly after the opaque lighting solution, preserving the required ordering and sampling semantics instead of treating it as another opaque tile.
- Give interaction and refinement different budgets. Interactive temporal reconstruction is an explicit quality mode; final captures use their declared resolution, samples, and convergence rules.
- Present through a first-class native viewport. Send low-rate status and capture results to the UI, not a mandatory round trip for every completed frame.

R1's browser implementation can retain WGSL and software traversal. The scene contract is shared; the execution technique need not be identical. That creates a native capability advantage rather than trying to beat Chrome by translating the same lowest-common-denominator API differently. It also creates a larger validation obligation: traversal, scene edits, materials, visual convergence, portability, and recovery all need evidence before cutover.

## Proposal E: redesign viewport composition

This is an architectural requirement independent of which renderer wins. Faster shaders will not fix unsupported transparent WKWebView composition.

### Preferred public-API model

Give the scene a first-class native viewport. Put web UI panels in separate docked regions. Use native overlay views for viewport-local controls that require transparency, hit testing, accessibility, and IME behavior. Define explicit coordinates, clipping, focus, capture, and DPI/rotation rules.

This avoids pretending an arbitrary DOM subtree can be transparently composited over a native surface. It fits new projects that can adopt a viewport contract, but it changes the consumer UI contract and needs owner approval. Prove it with a real scene, a translucent control, a text field/IME, a popup, resizing, occlusion, and capture before choosing it.

### Larger alternative

A native UI compositor with web islands removes the full-window WebView layering problem. It also creates obligations for font shaping, accessibility, input, clipboard, selection, and platform behavior. Prefer existing platform widgets or a proven UI stack unless the product actually needs a custom compositor. Do not infer a UI-framework win from the native GPU experiment.

## Proposal F: change the browser-host boundary

An embedded Chromium host would reuse the measured browser stack and normal DOM/WebGPU composition instead of reproducing it. It trades a larger runtime, update/security responsibilities, and different process/memory behavior for a mature GPU stack. This would ship a Chromium/Dawn runtime and therefore requires an explicit change to the current dependency constraint.

A browser-first application with a native companion service is another option: use the user's compatible browser for rendering and a capability-authenticated local service for archives, files, power facts, and other OS integration. It avoids bundling a browser but changes the deployment and windowing contract, requires browser compatibility checks and secure service lifecycle, and may not fit the original native-application vision.

Keep both alternatives visible. Do not select a slower native stack solely to preserve the label native, and do not discard the compiled-application goal merely because Chrome wins one workload.

## Proposal G: rewrite the engine in Zig

A complete Zig engine is possible, including a browser-Wasm target and a native target behind generated C-compatible interfaces. It should be selected for a demonstrated requirement: ownership/control, toolchain independence, native library integration, data-oriented geometry work, or capabilities that the current compiler cannot support.

There is no such compiler blocker in the tested engine today, and the native/Wasm reactor wall-time difference is tiny on this GPU-bound workload. A whole-engine rewrite is therefore not the leading explanation-driven optimization.

Use Zig first in a self-contained renderer core or geometry subsystem with the same inputs, outputs, allocations, and tests. Compare it with the existing native implementation. If the measured bottleneck remains GPU execution, choose shaders and rendering architecture before expanding the language migration. Preserve the TypeScript application/UI boundary unless replacing it has its own measured benefit.

## Execution program

The work packages are ordered by evidence dependencies, not estimates. Independent prototypes may proceed in parallel; timed GPU comparisons run serially with no competing agent builds or GPU tests.

| Work package | Question | Required artifact and gate |
| --- | --- | --- |
| W0: replay and measurement | Are the compared paths doing equivalent work, and where is the delay? | A bounded command/upload/event tape, calibrated frame timeline, matching shaders/layouts/constants, and a reproducible baseline |
| W1: completion and execution repair | How much can the current stack recover without changing algorithms? | Polling/event-wakeup ablations, a Metal trace, CPU/energy results, and a lifecycle-safe patch or a demonstrated limit |
| W2: direct Metal slice | Is the gap in shader translation or backend execution? | Real scene slice, frontend/executor controlled comparisons, capture parity, and cold/warm pipeline evidence |
| W3: public viewport | Can the application compose and operate correctly without WebKit SPI? | A public-API composition demo with real rendering, input, accessibility, resize, occlusion, and capture |
| W4: renderer-service prototype | Does owning scene state and scheduling improve latency, isolation, or resource reuse? | A versioned scene contract, persistent resources, crash/replay recovery, and measured image transfer/presentation |
| W5: algorithm challenger | Which alternative removes the actual GPU bottleneck? | One profiled technique, equal-quality comparison, update/build costs, and a portable fallback plan |
| W6: optional Zig evaluation | Does a language change solve a measured requirement? | A bounded component comparison; a whole-engine migration proposal only if its benefit is demonstrated |
| W7: acceptance | Is the selected architecture better for real applications? | Paired AC/Low Power results, image and temporal quality, latency/energy/idle data, reliability, and target-platform evidence |

### W0 details

Capture actual GPU commands and the referenced upload bytes, not only page-to-engine messages. Preserve immutable input hashes, resource lifetimes, capability negotiation, pipeline overrides, readback requests, and causal event dependencies. Deduplicate immutable uploads in the trace, bound its size, and keep production tracing off by default. Independent asynchronous completions need not have identical wall-clock order, but every causal dependency and exactly-once terminal event must hold.

Record frame count and work count: pixels, dimensions, passes, draws, dispatches, ray/sample budgets, GI progress, dirty state, and active features. Matching a desktop tier label or approximate final image is insufficient to prove identical work. Chrome exposes subgroups in this setup while the native backend does not; the captured corpus does not use subgroup operations, but future traces must log such differences.

Calibrate timestamps before using them to attribute pass costs. Use system GPU accounting for aggregate activity and Metal tools for pass attribution, with profiler overhead checked against uninstrumented runs. Do not sum overlapping CPU, GPU, and IPC metrics into a fabricated frame budget.

## Acceptance criteria to approve

These are proposed decision thresholds, not measured gains or promises.

- First reach parity: no material common-workload latency regression against Chrome at fixed work and quality. Then require a meaningful default-path benefit, proposed as at least 15% lower median frame latency or 15% lower energy per completed frame, with p95 latency no more than 5% worse. Confirm the thresholds with the product owner before treating them as gates.
- Make paired Low Power results binding. Measure on AC with the same power source for the mode comparison; treat battery versus AC as a separate variable. Log OS power/thermal facts before and after. Obtain permission or manual assistance for mode changes and restore the owner's original settings.
- Measure both uncapped work throughput and a matched presentation target. Faster unlimited rendering can consume more power; CPU time, memory footprint, and GPU busy time are not energy measurements. Use an appropriate authorized energy/power measurement over a sufficient window and report its scope.
- Match the existing image tolerance for unchanged algorithms. Approve separate static, temporal, and convergence criteria for a new algorithm; never silently loosen the old golden gate.
- Use representative scenes: the existing Bresso case, glass/reflection-heavy and texture-heavy cases, many lights, larger geometry, and frequent scene edits. Include still, moving, export, panorama, and video-frame behavior. Do not generalize one Apple GPU to all devices.
- Keep zero engine/GPU frames when nothing is requested, with no permanent poll loop and an explicit idle wakeup/CPU budget relative to the browser baseline.
- Test cancellation, map/unmap, bounded pressure, generation exhaustion, resize/DPR, visibility, device loss, renderer crash, replay recovery, and resource cleanup. A faster path that hangs when hidden or terminates the UI on an error does not pass.
- Define cold and warm startup honestly. An isolated Chrome profile does not clear its shared OS Metal cache. Compare owned caches or use a dedicated test environment; do not clear the user's shared caches to manufacture a cold race.
- Use a quiet test session and log geometry and competing GPU clients throughout each phase. AeroSpace resizing and another session's GPU jobs invalidated previous runs. Do not stop other users' work automatically. Randomize or alternate paired runs, report exclusions and distributions, and rerun until the decision is stable.

## Architecture decision rules

1. If completion/delivery fixes close the gap and energy is competitive, keep the portable executor and solve viewport composition independently.
2. If direct Metal wins using equivalent shaders, prefer the Metal execution path for Apple while keeping a portable backend elsewhere. Choose Zig or C++ based on maintainability and CPU evidence, not the GPU win's label.
3. If shader generation dominates, fix or replace that frontend path before rewriting scene/application logic. A shipping frontend dependency still needs explicit approval.
4. If hardware ray queries or a new graph/algorithm delivers the meaningful win, adopt a renderer-service API that can express those capabilities instead of stretching protocol 3 past its semantics.
5. If correct native/web composition cannot satisfy the product's UI requirements, choose between a native viewport/UI architecture and an explicitly approved browser-host change. Do not keep a private-API workaround as an invisible dependency.
6. If no candidate improves the required experience, retain the current portable/browser path. A measured negative result is preferable to making a rewrite the default without evidence.

## Decisions requested before implementation

- Is a first-class native viewport with web panels acceptable, or must arbitrary translucent DOM overlay the scene?
- Must a new renderer share one browser/native algorithm, or are capability-negotiated native techniques with a browser fallback acceptable?
- Should Zig be evaluated as a renderer/geometry component, or is reducing dependence on the TypeScript compiler itself a product objective?
- Is a Chromium/Dawn host still excluded? It remains excluded unless that constraint is explicitly changed.
- What quality/latency/energy thresholds should decide the default path, and who can authorize the paired Low Power measurement?

The recommended starting portfolio is W0/W1, W2, and W3. It tests the existing implementation, a real native challenger, and the public composition architecture without prematurely committing the application to a rewrite. W4 and W5 become the main path if those experiments justify the larger design.
