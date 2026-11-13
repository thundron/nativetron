// In-page benchmark driver (served as /nt-bench/driver.js by build-bundle.mjs; imported by bootstrap.js after the
// house-planner app entry). The SAME file drives every app path (Chrome JS WebGPU, WKWebView + native executor,
// WKWebView WebGPU); it only talks to the app's own scripting API (window.hpEngine / window.hpPresent) and, on the
// native path, the host's read-only stats route. Output: console lines (the runner reads Chrome's console through
// CDP and the macOS host's NT_MACOS_CONSOLE evidence on stdout; that channel takes ≤ 4096 chars, ≤ 60 lines/s):
//   NT_BENCH_MARK <json>       phase boundaries; the runner samples per-process CPU/GPU/footprint on each one
//   NT_BENCH_PART <i>/<n> <s>  the result JSON in pieces;   NT_BENCH_DONE <sha-ish length>;   NT_BENCH_ERROR <text>
// Procedure (mirrors the consumer's apps/web/src/engine/bench.ts so the counters mean what the app's own benchmark
// means; counts are fixed, nothing adapts to speed):
//   startup     the app's page times: lane up, scene uploaded, first frame with the scene (first-image criterion:
//               an engine status with scene > 0 followed by one more rendered frame), first GI convergence
//   settle      the engine's STATUS_SETTLED (≤ 20 s, else flagged with GI / direct / exposure state)
//   still       LIVING view: bench(5) warm-up, 5 × bench(10)          (frames rendered back to back, each waits
//   moving      bench(5, move) warm-up, 6 × bench(10, move)           for its GPU completion: wall ms per frame)
//   gpu         timestamp-query per pass (if the device has it): timing on, warm-up, 3 × bench(10, move) and
//               3 × bench(10) → stats.gpu (ms per pass, `frame` = whole frame span)
//   still-api   (opt-in ?ntStill) hpPresent.still({ width: 640, height: 400, samples: 1, format: 'png' }) wall ms;
//               the full app's status does not settle, so this measures hpPresent's 60 s settle timeout, not speed
//   idle        settle, then 10 s with nothing requested: engine frame count delta (idle frames) — the runner's
//               CPU/GPU samples at idle-start / idle-end give the processes' CPU after settle
//   memory      the engine's tracked allocations (stats: GI, direct, reflections, targets) — NOT physical residency
const LIVING = [[19.0, 1.6, -13.0], [16.0, 1.0, -15.5]];
const params = new URLSearchParams(location.search);
const REPS = Number(params.get('ntReps') ?? 1);
// ntQuick: harness smoke only (tiny counts, short idle) — never a measurement
const QUICK = params.has('ntQuick');
const N = QUICK ? { warm: 1, still: 1, move: 1, per: 2, gpu: 1, idleMs: 1000, stillApi: 1 } : { warm: 5, still: 5, move: 6, per: 10, gpu: 3, idleMs: 10000, stillApi: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sorted = (a) => [...a].sort((x, y) => x - y);
const med = (a) => sorted(a)[a.length >> 1] ?? null;
const t0 = performance.now();
const boot = globalThis.__ntBenchBoot ?? { native: false };
const native = globalThis.__ntBenchNativeGpu ?? null;
const out = { schema: 'nt-bench-driver/1', quick: QUICK, counts: N, userAgent: navigator.userAgent, location: location.origin + location.pathname + location.search, boot,
  window: { innerWidth, innerHeight, devicePixelRatio, screen: { width: screen.width, height: screen.height } }, marks: [], phases: {} };

let markSeq = 0;
// The runner samples the processes when it reads the line (a few ms later). A phase start is marked after a quiet
// 250 ms and the phase follows at once; a phase end is marked at once and followed by 250 ms of quiet, so the sampled
// window misses / adds only the console delivery latency, not the quiet time.
async function mark(name, extra = {}) {
  const start = /-start/.test(name);
  if (start) await sleep(250);
  if (native) extra = { ...extra, native: await nativeStats() };
  const m = { seq: markSeq++, name, t: performance.now(), ...extra };
  out.marks.push(m);
  console.log('NT_BENCH_MARK ' + JSON.stringify({ seq: m.seq, name, t: m.t }));
  if (!start) await sleep(250);
}
async function nativeStats() {
  try {
    const r = await fetch(`${native.endpoint}stats`, { headers: { 'X-NT-GPU-Session': native.session }, cache: 'no-store' });
    return r.ok ? await r.json() : { status: r.status };
  } catch (e) { return { error: String(e) }; }
}
// Settled = the engine's own STATUS_SETTLED (nothing converges, no frame owed). In the full app (unlike the bare
// `?engine` page bench.ts targets) the direct light can stay `pending` and the status never settles — also in Chrome
// (the consumer's still recording waited out hpPresent's 60 s settle timeout): bounded wait, recorded, not hidden.
async function settled(e, ms = 20000) {
  const t = performance.now();
  while (performance.now() - t < ms) {
    if (e.status?.settled) return { ms: performance.now() - t, timedOut: false };
    await sleep(100);
  }
  const s = await e.stats();
  return { ms: performance.now() - t, timedOut: true, gi: s.gi?.phase ?? null, directPending: s.direct?.pending ?? null, exposurePending: s.exposure?.pending ?? null };
}
function emit(obj) {
  const s = JSON.stringify(obj), size = 3500, n = Math.ceil(s.length / size);
  return (async () => {
    for (let i = 0; i < n; i++) { console.log(`NT_BENCH_PART ${i + 1}/${n} ${s.slice(i * size, (i + 1) * size)}`); if (i % 15 === 14) await sleep(600); }
    console.log(`NT_BENCH_DONE ${s.length}`);
  })();
}

async function run() {
  for (let i = 0; !window.hpEngine; i++) { if (i > 1200) throw new Error('window.hpEngine never appeared (raster fallback?)'); await sleep(100); }
  const e = window.hpEngine;
  out.appView = 'engine';
  out.engineNative = Boolean(e.lane?.nativeGpu ?? globalThis.__ntBenchNativeGpuUsed);
  out.nativeWrapperUsed = globalThis.__ntBenchNativeGpuUsed ?? 0;
  await e.settled?.();
  for (let i = 0; !(e.startup?.converged > 0) && i < 1200; i++) await sleep(100);
  out.startup = { ...e.startup };
  await mark('startup-done');
  e.setView(LIVING[0], LIVING[1]); await sleep(300);
  out.phases.settle = await settled(e);
  const s0 = await e.stats();
  out.stats0 = s0;
  out.canvas = { width: s0.width, height: s0.height, tier: s0.tier?.name ?? null, cssWidth: document.getElementById('viewport')?.clientWidth, cssHeight: document.getElementById('viewport')?.clientHeight };
  for (let rep = 0; rep < REPS; rep++) {
    const ph = {};
    await mark(`still-start:${rep}`);
    const warmStill = await e.bench(N.warm);
    const still = []; for (let i = 0; i < N.still; i++) still.push((await e.bench(N.per)).frameMs);
    await mark(`still-end:${rep}`, { frames: N.warm + N.still * N.per });
    ph.still = { warmupFrameMs: warmStill.frameMs, frameMs: still, median: med(still), frames: N.warm + N.still * N.per, framesPerSample: N.per };
    await mark(`moving-start:${rep}`);
    const warmMove = await e.bench(N.warm, { move: true });
    const moving = []; let last = null;
    for (let i = 0; i < N.move; i++) { const r = await e.bench(N.per, { move: true }); moving.push(r.frameMs); last = r.stats; }
    await mark(`moving-end:${rep}`, { frames: N.warm + N.move * N.per });
    ph.moving = { warmupFrameMs: warmMove.frameMs, frameMs: moving, median: med(moving), frames: N.warm + N.move * N.per, framesPerSample: N.per, gi: last?.gi ? { phase: last.gi.phase, width: last.gi.width, height: last.gi.height } : null };
    const timed = s0.tier?.features?.timestamps ?? false;
    ph.gpuTimestamps = timed;
    if (timed) {
      e.timing(true); await e.bench(N.warm, { move: true });
      const mv = []; for (let i = 0; i < N.gpu; i++) mv.push((await e.bench(N.per, { move: true })).stats.gpu);
      const st = []; for (let i = 0; i < N.gpu; i++) st.push((await e.bench(N.per)).stats.gpu);
      e.timing(false);
      ph.gpu = { moving: mv, still: st, movingFrameMedian: med(mv.map((g) => g.frame ?? 0)), stillFrameMedian: med(st.map((g) => g.frame ?? 0)) };
    }
    out.phases[`rep${rep}`] = ph;
  }
  // the app's still API (converged raw capture → PNG): wall time, first and repeated
  if (window.hpPresent && params.has('ntStill')) { // opt-in: bounded by hpPresent's 60 s settle timeout in the full app
    const lat = [];
    for (let i = 0; i < N.stillApi; i++) {
      await mark(`still-api-start:${i}`);
      const t = performance.now();
      const png = await window.hpPresent.still({ width: 640, height: 400, samples: 1, format: 'png' });
      lat.push({ ms: performance.now() - t, bytes: png?.length ?? png?.byteLength ?? png?.size ?? null });
      await mark(`still-api-end:${i}`);
    }
    out.phases.stillApi = lat;
    e.setView(LIVING[0], LIVING[1]);
  }
  let b;
  if (!params.has('ntNoIdle')) { // ntNoIdle: input recording for the CLI replay (an idle wait replays as nothing)
    await sleep(500);
    out.phases.settleBeforeIdle = await settled(e);
    await sleep(2000);
    const a = await e.stats();
    await mark('idle-start', { frames: a.frames });
    await sleep(N.idleMs);
    b = await e.stats();
    await mark('idle-end', { frames: b.frames });
    out.phases.idle = { seconds: N.idleMs / 1000, engineFrames: b.frames - a.frames };
    // image sanity check (after the idle window): the golden procedure (LIVING, runGi(64), capture()) and a 16×16
    // box-averaged thumbnail; summarize.mjs compares paths with the golden per-pixel rule on the thumbnail. A coarse
    // "same scene rendered" check, not the committed golden test (gpu/native/reactor/e2e.sh does that at full size).
    e.setView(LIVING[0], LIVING[1]); await sleep(300);
    const tg = performance.now();
    await e.runGi(64);
    const img = await e.capture();
    const B = 16, tw = Math.floor(img.width / B), th = Math.floor(img.height / B), thumb = new Uint8Array(tw * th * 3);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let yy = 0; yy < B; yy++) for (let xx = 0; xx < B; xx++) sum += img.rgba[((y * B + yy) * img.width + x * B + xx) * 4 + c];
      thumb[(y * tw + x) * 3 + c] = Math.round(sum / (B * B));
    }
    let bin = ''; for (let i = 0; i < thumb.length; i++) bin += String.fromCharCode(thumb[i]);
    out.check = { procedure: 'setView LIVING, runGi(64), capture()', ms: performance.now() - tg, width: img.width, height: img.height, block: B, thumbWidth: tw, thumbHeight: th, thumbBase64: btoa(bin) };
  } else b = await e.stats();
  const giMB = b.gi?.memoryMB ?? 0, diMB = b.direct?.memoryMB ?? 0, rfMB = b.reflections?.memoryMB ?? 0, sh = b.tier?.shadowSize ?? 0;
  const targetsMB = (b.width * b.height * 40 + sh * sh * 4) / 1048576;
  out.trackedMemoryMB = { gi: giMB, direct: diMB, reflections: rfMB, targets: +targetsMB.toFixed(1), total: +(giMB + diMB + rfMB + targetsMB).toFixed(1), note: 'engine-tracked allocations (bench.ts formula), not physical residency' };
  out.statsEnd = b;
  out.totalMs = performance.now() - t0;
}

run().then(() => emit(out), (err) => { console.log('NT_BENCH_ERROR ' + String(err?.stack ?? err).slice(0, 3000)); out.error = String(err); return emit(out); });
