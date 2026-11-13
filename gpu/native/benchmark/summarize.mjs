// Aggregates raw run JSON (run.mjs app paths, cli-bench.mjs CLI path) into results.csv (one row per run, raw
// values), summary.json and summary.md (medians per path and power mode). Nothing here measures; it only derives.
//   node gpu/native/benchmark/summarize.mjs --runs <dir with <mode>/{app,cli}/*.json> --out <dir>
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RUNS = resolve(opt('--runs', '/tmp/nt-native-gpu-measurements-root/runs'));
const OUT = resolve(opt('--out', RUNS));
const sorted = (a) => [...a].filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((x, y) => x - y);
const med = (a) => { const s = sorted(a); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const min = (a) => sorted(a)[0] ?? null, max = (a) => sorted(a).at(-1) ?? null;
const r2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

const klass = (name = '') => /^Nativetron$/.test(name) ? 'app'
  : /WebKit\.WebContent|Helper \(Renderer\)/.test(name) ? 'content'
  : /WebKit\.GPU|Helper \(GPU\)/.test(name) ? 'gpuProcess'
  : /^Google Chrome$/.test(name) ? 'browser' : 'other';

/** per-class deltas between two probe samples (missing pid at start = 0, gone at end = last seen) */
function delta(a, b) {
  const out = {};
  for (const [pid, p1] of Object.entries(b?.procs ?? {})) {
    const p0 = a?.procs?.[pid];
    if (p1.gone) continue;
    const k = klass(p1.name);
    out[k] ??= { cpuMs: 0, gpuMs: 0, wakeups: 0 };
    out[k].cpuMs += (p1.cpu_ns - (p0 && !p0.gone ? p0.cpu_ns : 0)) / 1e6;
    out[k].gpuMs += (p1.gpu_ns - (p0 && !p0.gone ? p0.gpu_ns : 0)) / 1e6;
    out[k].wakeups += p1.wakeups - (p0 && !p0.gone ? p0.wakeups : 0);
  }
  return out;
}
const total = (d, key) => Object.values(d).reduce((s, x) => s + x[key], 0);
const footprint = (s) => { const out = {}; for (const p of Object.values(s?.procs ?? {})) if (!p.gone) { const k = klass(p.name); out[k] = (out[k] ?? 0) + p.phys_footprint / 1048576; } return out; };
const nativeDelta = (a, b) => { if (!a || !b) return null; const o = {}; for (const k of Object.keys(b)) if (typeof b[k] === 'number') o[k] = b[k] - (a[k] ?? 0); return o; };

function appRow(mode, file, run) {
  const d = run.driver ?? {}, ph = d.phases ?? {}, rep = ph.rep0 ?? {};
  const sampleOf = (name) => run.samples.find((s) => s.mark.name === name);
  const markOf = (name) => d.marks?.find((m) => m.name === name);
  const phase = (from, to, frames) => {
    const a = sampleOf(from), b = sampleOf(to); if (!a || !b) return null;
    const dd = delta(a.probe, b.probe), secs = (b.mark.t - a.mark.t) / 1000;
    const nd = nativeDelta(markOf(from)?.native, markOf(to)?.native);
    return { secs, frames, cpuMsPerFrame: total(dd, 'cpuMs') / frames, gpuMsPerFrame: total(dd, 'gpuMs') / frames, byClass: dd,
      native: nd && { submissionsPerFrame: nd.submissions / frames, bodyBytesPerFrame: nd.bodyBytes / frames, uploadBytesPerFrame: nd.uploadBytes / frames, commandBytesPerFrame: nd.commandBytes / frames,
        readbackBytesPerFrame: nd.readbackBytes / frames, downBytesPerFrame: nd.downBytes / frames, reassemblyBytesPerFrame: nd.reassemblyBytes / frames, readbackCopyBytesPerFrame: nd.readbackCopyBytes / frames,
        pollsPerFrame: nd.polls / frames, submitMsPerSubmission: nd.submitMs / Math.max(1, nd.submissions), bodyQueueMsPerBody: nd.bodyQueueMs / Math.max(1, nd.bodies), raw: nd } };
  };
  const still = phase('still-start:0', 'still-end:0', markOf('still-end:0')?.frames ?? rep.still?.frames);
  const moving = phase('moving-start:0', 'moving-end:0', markOf('moving-end:0')?.frames ?? rep.moving?.frames);
  const idleA = sampleOf('idle-start'), idleB = sampleOf('idle-end');
  const idle = idleA && idleB ? (() => { const dd = delta(idleA.probe, idleB.probe), s = (idleB.mark.t - idleA.mark.t) / 1000; return { secs: s, cpuMsPerSec: total(dd, 'cpuMs') / s, gpuMsPerSec: total(dd, 'gpuMs') / s, wakeupsPerSec: total(dd, 'wakeups') / s, byClass: dd }; })() : null;
  const startupNative = markOf('startup-done')?.native ?? null;
  return {
    mode, kind: 'app', path: run.path, index: run.index, file, ok: run.ok, error: run.error ?? null,
    cache: run.path === 'chrome' ? `chrome-profile-${run.cache?.chromeProfile}` : `metal-cache-${run.cache?.metalCacheBefore?.exists ? 'present' : 'absent'}`,
    lowPowerBefore: run.power?.before?.isLowPowerModeEnabled, lowPowerAfter: run.power?.after?.isLowPowerModeEnabled,
    thermalBefore: run.power?.before?.thermalState, thermalAfter: run.power?.after?.thermalState, source: run.power?.before?.providingPowerSource,
    native: d.engineNative ?? null, composition: d.boot?.composition ?? null, canvas: d.canvas ? `${d.canvas.width}x${d.canvas.height}` : null, tier: d.canvas?.tier ?? null,
    viewport: d.window ? `${d.window.innerWidth}x${d.window.innerHeight}@${d.window.devicePixelRatio}` : null, hostViewport: run.hostViewport ?? null,
    startupLaneMs: d.startup?.lane, startupUploadedMs: d.startup?.uploaded, firstImageMs: d.startup?.firstFrame, firstConvergedMs: d.startup?.converged,
    bootHostMs: run.bootHostMs, launchToBootMs: run.bootHostMs - run.launchHostMs,
    settleTimedOut: ph.settle?.timedOut ?? null,
    stillFrameMs: rep.still?.median, stillFrameMsAll: rep.still?.frameMs, stillWarmupFrameMs: rep.still?.warmupFrameMs,
    movingFrameMs: rep.moving?.median, movingFrameMsAll: rep.moving?.frameMs, movingWarmupFrameMs: rep.moving?.warmupFrameMs,
    gpuTsStillFrameMs: rep.gpu?.stillFrameMedian ?? null, gpuTsMovingFrameMs: rep.gpu?.movingFrameMedian ?? null,
    still, moving, idle, idleEngineFrames: ph.idle?.engineFrames ?? null,
    footprintIdleEndMB: footprint(idleB?.probe ?? run.final), trackedMemoryMB: d.trackedMemoryMB?.total ?? null,
    nativeStartup: startupNative && { executorCreateMs: startupNative.executorCreateMs, submitMaxMs: startupNative.submitMaxMs, submitMs: startupNative.submitMs, submissions: startupNative.submissions, uploadBytes: startupNative.uploadBytes, commandBytes: startupNative.commandBytes },
    contentionBefore: run.contention?.before?.gpuClients?.filter((g) => !/WindowServer/.test(g.comm)) ?? [],
    check: d.check ? { width: d.check.width, height: d.check.height, ms: d.check.ms, tw: d.check.thumbWidth, th: d.check.thumbHeight, thumb: d.check.thumbBase64 } : null,
  };
}
/** golden rule on the 16× thumbnails: a pixel differs when a channel differs by more than 12/255 (fail > 0.5 %) */
function compareThumbs(a, b) {
  if (!a || !b || a.tw !== b.tw || a.th !== b.th) return null;
  const x = Buffer.from(a.thumb, 'base64'), y = Buffer.from(b.thumb, 'base64');
  let over = 0, maxDelta = 0;
  for (let i = 0; i < x.length; i += 3) { let m = 0; for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(x[i + c] - y[i + c])); maxDelta = Math.max(maxDelta, m); if (m > 12) over++; }
  const pct = (100 * over) / (x.length / 3);
  return { pctOver: r2(pct), maxDelta, pass: pct <= 0.5 };
}

function cliRows(mode, file, run) {
  const b = run.bench ?? [];
  // the driver's order: still warm-up, still ×N, moving warm-up, moving ×M, timing warm-up, timed moving ×K, timed still ×K
  const still = b.filter((x, i) => !x.move && i > 0 && i < b.findIndex((y) => y.move));
  const firstMove = b.findIndex((x) => x.move);
  const moving = []; for (let i = firstMove + 1; i < b.length && b[i].move; i++) moving.push(b[i]);
  return [{
    mode, kind: 'cli', path: `cli-${run.guest}`, index: run.index, file, ok: run.ok, lowPowerBefore: run.powerBefore?.isLowPowerModeEnabled, lowPowerAfter: run.powerAfter?.isLowPowerModeEnabled,
    thermalBefore: run.powerBefore?.thermalState, thermalAfter: run.powerAfter?.thermalState, source: run.powerBefore?.providingPowerSource,
    stillFrameMs: med(still.map((x) => x.frameMs)), movingFrameMs: med(moving.map((x) => x.frameMs)),
    stillCpuMsPerFrame: med(still.map((x) => x.cpuMsPerFrame)), movingCpuMsPerFrame: med(moving.map((x) => x.cpuMsPerFrame)),
    stillGpuMsPerFrame: med(still.map((x) => x.gpuMsPerFrame)), movingGpuMsPerFrame: med(moving.map((x) => x.gpuMsPerFrame)),
    stillFrameMsAll: still.map((x) => x.frameMs), movingFrameMsAll: moving.map((x) => x.frameMs),
    preambleWallMs: run.preamble?.wallMs, preambleMaxStepMs: run.preamble?.maxStepMs, peakFootprintMB: run.totals?.peakFootprintMB,
    frameSyncDivergences: run.reactorRun?.frameSyncDivergences ?? null, executor: run.reactorRun?.executor ?? null,
  }];
}

const rows = [];
for (const mode of readdirSync(RUNS).filter((d) => statSync(join(RUNS, d)).isDirectory())) {
  for (const sub of ['app', 'cli']) {
    const dir = join(RUNS, mode, sub); if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const run = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (sub === 'app') rows.push(appRow(mode, join(mode, sub, f), run)); else rows.push(...cliRows(mode, join(mode, sub, f), run));
    }
  }
}

// image check: every app run vs the first ok Chrome run of its mode (Chrome vs Chrome = run-to-run noise)
for (const r of rows) {
  if (r.kind !== 'app') continue;
  const ref = rows.find((x) => x.mode === r.mode && x.path === 'chrome' && x.ok && x.check && x !== r) ?? null;
  r.checkVsChrome = ref ? { ref: ref.file, ...compareThumbs(r.check, ref.check) } : null;
}
// medians per (mode, path) over ok runs; startup split cold (index 0) / warm (index > 0)
const groups = new Map();
for (const r of rows) { const k = `${r.mode}|${r.path}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
const summary = [];
for (const [k, rs] of groups) {
  const [mode, path] = k.split('|'), ok = rs.filter((r) => r.ok), warm = ok.filter((r) => r.index > 0), cold = ok.find((r) => r.index === 0);
  const m = (f) => r2(med(ok.map(f)));
  summary.push({
    mode, path, runs: rs.length, ok: ok.length, canvas: [...new Set(ok.map((r) => r.canvas).filter(Boolean))].join(' ') || null,
    lowPower: [...new Set(rs.flatMap((r) => [r.lowPowerBefore, r.lowPowerAfter]))].join('/'), thermal: [...new Set(rs.flatMap((r) => [r.thermalBefore, r.thermalAfter]))].join('/'),
    stillFrameMs: m((r) => r.stillFrameMs), stillFrameMsRange: [r2(min(ok.map((r) => r.stillFrameMs))), r2(max(ok.map((r) => r.stillFrameMs)))],
    movingFrameMs: m((r) => r.movingFrameMs), movingFrameMsRange: [r2(min(ok.map((r) => r.movingFrameMs))), r2(max(ok.map((r) => r.movingFrameMs)))],
    stillCpuMsPerFrame: m((r) => r.still?.cpuMsPerFrame ?? r.stillCpuMsPerFrame), movingCpuMsPerFrame: m((r) => r.moving?.cpuMsPerFrame ?? r.movingCpuMsPerFrame),
    stillGpuMsPerFrame: m((r) => r.still?.gpuMsPerFrame ?? r.stillGpuMsPerFrame), movingGpuMsPerFrame: m((r) => r.moving?.gpuMsPerFrame ?? r.movingGpuMsPerFrame),
    gpuTsStillFrameMs: m((r) => r.gpuTsStillFrameMs), gpuTsMovingFrameMs: m((r) => r.gpuTsMovingFrameMs),
    firstImageMsCold: r2(cold?.firstImageMs), firstImageMsWarm: r2(med(warm.map((r) => r.firstImageMs))), convergedMsCold: r2(cold?.firstConvergedMs), convergedMsWarm: r2(med(warm.map((r) => r.firstConvergedMs))),
    launchToBootMsCold: r2(cold?.launchToBootMs), launchToBootMsWarm: r2(med(warm.map((r) => r.launchToBootMs))),
    nativeStartupSubmitMaxMsCold: r2(cold?.nativeStartup?.submitMaxMs), nativeStartupSubmitMaxMsWarm: r2(med(warm.map((r) => r.nativeStartup?.submitMaxMs))),
    preambleWallMs: m((r) => r.preambleWallMs), preambleMaxStepMs: m((r) => r.preambleMaxStepMs),
    idleEngineFrames: m((r) => r.idleEngineFrames), idleCpuMsPerSec: m((r) => r.idle?.cpuMsPerSec), idleGpuMsPerSec: m((r) => r.idle?.gpuMsPerSec), idleWakeupsPerSec: m((r) => r.idle?.wakeupsPerSec),
    footprintIdleEndMB: ok.length ? Object.fromEntries(Object.keys(ok[0].footprintIdleEndMB ?? {}).map((c) => [c, r2(med(ok.map((r) => r.footprintIdleEndMB?.[c])))])) : null,
    peakFootprintMB: m((r) => r.peakFootprintMB), trackedMemoryMB: m((r) => r.trackedMemoryMB),
    movingWireBytesPerFrame: m((r) => r.moving?.native?.bodyBytesPerFrame), movingUploadBytesPerFrame: m((r) => r.moving?.native?.uploadBytesPerFrame),
    movingCommandBytesPerFrame: m((r) => r.moving?.native?.commandBytesPerFrame), movingReadbackBytesPerFrame: m((r) => r.moving?.native?.readbackBytesPerFrame),
    movingDownBytesPerFrame: m((r) => r.moving?.native?.downBytesPerFrame), movingReassemblyBytesPerFrame: m((r) => r.moving?.native?.reassemblyBytesPerFrame),
    movingSubmissionsPerFrame: m((r) => r.moving?.native?.submissionsPerFrame), movingSubmitMsPerSubmission: m((r) => r.moving?.native?.submitMsPerSubmission),
    movingBodyQueueMsPerBody: m((r) => r.moving?.native?.bodyQueueMsPerBody), movingPollsPerFrame: m((r) => r.moving?.native?.pollsPerFrame),
    checkVsChromeMaxPctOver: r2(max(ok.map((r) => r.checkVsChrome?.pctOver))), checkVsChromeAllPass: ok.every((r) => !r.checkVsChrome || r.checkVsChrome.pass),
  });
}
summary.sort((a, b) => (a.mode + a.path).localeCompare(b.mode + b.path));

const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [[`${p}${k}`, Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? r2(x) : JSON.stringify(x))).join(';') : v]]);
const flatRows = rows.map(({ check, ...r }) => Object.fromEntries(flat({ ...r, check: check ? { width: check.width, height: check.height, ms: check.ms } : null })));
const cols = [...new Set(flatRows.flatMap((r) => Object.keys(r)))];
const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(typeof v === 'number' ? r2(v) : v));
writeFileSync(join(OUT, 'results.csv'), [cols.join(','), ...flatRows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), runsDir: RUNS, summary, rows }, null, 1));
const scols = ['mode', 'path', 'ok', 'canvas', 'lowPower', 'thermal', 'stillFrameMs', 'movingFrameMs', 'stillCpuMsPerFrame', 'movingCpuMsPerFrame', 'stillGpuMsPerFrame', 'movingGpuMsPerFrame', 'gpuTsMovingFrameMs',
  'firstImageMsCold', 'firstImageMsWarm', 'convergedMsCold', 'convergedMsWarm', 'idleEngineFrames', 'idleCpuMsPerSec', 'idleGpuMsPerSec', 'trackedMemoryMB', 'movingWireBytesPerFrame', 'movingReadbackBytesPerFrame', 'movingSubmitMsPerSubmission', 'checkVsChromeMaxPctOver'];
const md = ['| ' + scols.join(' | ') + ' |', '|' + scols.map(() => '---').join('|') + '|', ...summary.map((s) => '| ' + scols.map((c) => (s[c] === null || s[c] === undefined ? '—' : String(s[c]))).join(' | ') + ' |')];
writeFileSync(join(OUT, 'summary.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
