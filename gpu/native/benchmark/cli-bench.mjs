// CLI path: replays the recorded benchmark session (record-bench.mjs) through nt-reactor on the native executor —
// the engine as a native library (`native:` libhp-engine.dylib) and as the same Wasm reactor in Node/V8 (`wasm:`),
// both on the SAME executor dylib — and reports wall / CPU / kernel-GPU time per T_BENCH request.
//
//   node gpu/native/benchmark/cli-bench.mjs --root <R> --recording <R>/recordings/bench --reactor <nt-reactor>
//        --executor-lib <libntgpu-executor.dylib> --out <dir> [--guests native,wasm] [--runs 3]
//        [--engine-dylib /tmp/nt-native-reactor-1/bin/libhp-engine.dylib] [--engine-wasm /tmp/nt-native-reactor-1/out/wasm]
//        [--reactor-src <nativetron>/gpu/native/reactor]
//
// What this is NOT: the app. No WKWebView, no page, no wire crossing, no presentation; the replay is frame-
// synchronous (gpu/native/reactor/README.md) with a lockstep pump (each frame waits until the executor has nothing
// pending). It is the best-case headless workload number for this engine on this executor, reported separately.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, basename } from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(opt('--root', '/tmp/nt-native-gpu-measurements-root'));
const REC = resolve(opt('--recording', join(ROOT, 'recordings/bench')));
const REACTOR = opt('--reactor', '/tmp/nt-native-gpu-final/reactor/nt-reactor');
const EXEC = opt('--executor-lib', '/tmp/nt-native-gpu-final/reactor/libntgpu-executor.dylib');
const OUT = resolve(opt('--out', join(ROOT, 'runs/cli')));
const GUESTS = opt('--guests', 'native,wasm').split(',');
const RUNS = Number(opt('--runs', 1));
const DYLIB = opt('--engine-dylib', '/tmp/nt-native-reactor-1/bin/libhp-engine.dylib');
const WASM = opt('--engine-wasm', '/tmp/nt-native-reactor-1/out/wasm');
const SRC = resolve(opt('--reactor-src', new URL('../reactor', import.meta.url).pathname));
const LABEL = opt('--label', 'adhoc');
const QUIET = Number(opt('--wait-quiet', 0));
const FIRST = Number(opt('--first-index', 0));
const PROBE = join(ROOT, 'bin/nt-bench-probe');
const WS = (/^\s*(\d+)\s+\S*WindowServer/m.exec(execFileSync('ps', ['-A', '-o', 'pid=,comm='], { encoding: 'utf8' })) ?? [])[1] ?? '595';
for (const f of [join(REC, 'recording.json'), REACTOR, EXEC, PROBE, join(SRC, 'scenario.mjs')]) if (!existsSync(f)) throw new Error(`missing ${f}`);
mkdirSync(OUT, { recursive: true });

const rec = JSON.parse(readFileSync(join(REC, 'recording.json'), 'utf8'));
const byFile = new Map(rec.messages.filter((m) => m.file).map((m) => [basename(m.file), m]));
const scenarioDir = join(OUT, 'scenario');
execFileSync(process.execPath, [join(SRC, 'scenario.mjs'), 'app', scenarioDir, '--recording', join(REC, 'recording.json'), '--hp', join(ROOT, 'sandbox/hp')], { stdio: 'inherit' });
const script = readFileSync(join(scenarioDir, 'script.txt'), 'utf8').split('\n');
const power = () => { try { return JSON.parse(execFileSync(PROBE, ['power'], { encoding: 'utf8' })); } catch (e) { return { error: String(e) }; } };
const psTree = (root) => {
  const t = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const out = new Set([root]); let grew = true;
  while (grew) { grew = false; for (const [p, pp] of t) if (out.has(pp) && !out.has(p)) { out.add(p); grew = true; } }
  return [...out];
};

async function oneRun(guest, index) {
  const dir = join(OUT, `${guest}-${String(index).padStart(2, '0')}`);
  const spec = guest === 'native' ? `native:${DYLIB}` : `wasm:${WASM}`;
  const args = ['run', '--engine', spec, '--executor-lib', EXEC, '--script', join(scenarioDir, 'script.txt'), '--out', dir, '--width', String(rec.viewport.width), '--height', String(rec.viewport.height), '--dpr', String(rec.viewport.dpr), '--event-order', 'request', '--timeout-ms', '300000'];
  const run = { schema: 'nt-bench-cli/1', foreignPerPid: true, label: LABEL, guest, index, args: [REACTOR, ...args], recording: REC, powerBefore: power(), samples: [] };
  // 20 Hz probe of nt-reactor and its children (the wasm guest's Node), same clock as timepoints.csv (mach absolute)
  const probe = spawn(PROBE, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: probe.stdout });
  let waiting = null; lines.on('line', (l) => { const w = waiting; waiting = null; w?.(JSON.parse(l)); });
  const ask = (pids) => new Promise((r) => { waiting = r; probe.stdin.write(pids.join(',') + '\n'); });
  if (QUIET > 0) { // as run.mjs --wait-quiet: other Metal clients (WindowServer excluded) ≤ QUIET ms/s over 3 s, ≤ 10 min
    const w0 = Date.now();
    for (;;) {
      const a = await ask([]); await new Promise((r) => setTimeout(r, 3000)); const b = await ask([]);
      const foreign = Object.entries(b.gpu_all).filter(([pid]) => pid !== WS).reduce((x, [pid, ns]) => x + Math.max(0, ns - (a.gpu_all[pid] ?? ns)), 0) / 1e6 / 3;
      if (foreign <= QUIET || Date.now() - w0 > 600000) { run.quietWait = { thresholdMsPerS: QUIET, waitedMs: Date.now() - w0, foreignMsPerS: foreign, met: foreign <= QUIET }; break; }
    }
  }
  const child = spawn(REACTOR, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  let alive = true; const exited = new Promise((r) => child.on('exit', (code) => { alive = false; run.exit = code; r(); }));
  const last = new Map(); // pid → last counters: cumulative sums never drop when a process exits
  let prevAll = {}, foreignTotal = 0;
  while (alive) {
    const s = await ask(psTree(child.pid));
    for (const [pid, p] of Object.entries(s.procs)) if (!p.gone) last.set(pid, p);
    const live = Object.values(s.procs).filter((p) => !p.gone);
    run.samples.push({ t_ns: s.t_ns, cpu_ns: [...last.values()].reduce((a, p) => a + p.cpu_ns, 0), gpu_ns: [...last.values()].reduce((a, p) => a + p.gpu_ns, 0),
      footprint: live.reduce((a, p) => a + p.phys_footprint, 0), names: live.map((p) => p.name),
      // every other Metal client's GPU ns since the previous sample, accumulated (WindowServer and this run's processes
      // excluded; per pid, only increases: a client that closes or a process that exits never subtracts)
      foreign_ns: (foreignTotal += Object.entries(s.gpu_all).filter(([pid]) => !(pid in s.procs) && pid !== WS && prevAll[pid] !== undefined)
        .reduce((a, [pid, ns]) => a + Math.max(0, ns - prevAll[pid]), 0)) });
    prevAll = s.gpu_all;
    await Promise.race([exited, new Promise((r) => setTimeout(r, 50))]);
  }
  probe.stdin.end(); probe.kill();
  run.log = log.slice(-4000);
  run.powerAfter = power();
  // per T_BENCH request: receive step → its wait-result step (timepoints.csv: mach-absolute ns)
  const tp = readFileSync(join(dir, 'timepoints.csv'), 'utf8').trim().split('\n').slice(1).map((l) => { const c = l.split(','); return { step: +c[0], line: +c[1], op: c[2], t0: +c[4], t1: +c[5], frames: +c[6] }; });
  const at = (t, k) => { // linear interpolation of a cumulative counter at t
    const s = run.samples; if (!s.length) return null;
    if (t <= s[0].t_ns) return s[0][k]; if (t >= s[s.length - 1].t_ns) return s[s.length - 1][k];
    let i = s.findIndex((x) => x.t_ns >= t); const a = s[i - 1], b = s[i];
    return a[k] + (b[k] - a[k]) * (t - a.t_ns) / (b.t_ns - a.t_ns);
  };
  run.bench = [];
  for (let i = 0; i < tp.length; i++) {
    const s = tp[i]; if (s.op !== 'receive') continue;
    const m = byFile.get(basename(script[s.line - 1]?.split('@')[1] ?? ''));
    if (!m || m.benchFrames === undefined) continue;
    const w = tp.slice(i + 1).find((x) => x.op === 'wait-result');
    if (!w) continue;
    const wall = (w.t1 - s.t0) / 1e6, cpu = at(w.t1, 'cpu_ns') - at(s.t0, 'cpu_ns'), gpu = at(w.t1, 'gpu_ns') - at(s.t0, 'gpu_ns');
    const foreign = (at(w.t1, 'foreign_ns') - at(s.t0, 'foreign_ns')) / 1e6 / ((w.t1 - s.t0) / 1e9);
    run.bench.push({ foreignGpuMsPerSec: foreign, t0: s.t0, t1: w.t1, rid: m.rid, frames: m.benchFrames, move: (m.benchFlags & 1) === 1, wallMs: wall, frameMs: wall / m.benchFrames, cpuMsPerFrame: cpu / 1e6 / m.benchFrames, gpuMsPerFrame: gpu / 1e6 / m.benchFrames, chromeHeadlessRecordMs: m.chromeHeadlessMs ?? null });
  }
  const first = tp.find((x) => x.op === 'receive' && byFile.get(basename(script[x.line - 1]?.split('@')[1] ?? ''))?.benchFrames !== undefined);
  run.preamble = first ? { wallMs: (first.t0 - tp[0].t0) / 1e6, maxStepMs: Math.max(...tp.filter((x) => x.t0 < first.t0).map((x) => (x.t1 - x.t0) / 1e6)), note: 'replay of scene load / settle up to the first T_BENCH (frame-synchronous, includes executor pipeline creation)' } : null;
  run.totals = { wallMs: (tp[tp.length - 1].t1 - tp[0].t0) / 1e6, cpuMs: (run.samples.at(-1).cpu_ns - run.samples[0].cpu_ns) / 1e6, gpuMs: (run.samples.at(-1).gpu_ns - run.samples[0].gpu_ns) / 1e6, peakFootprintMB: Math.max(...run.samples.map((x) => x.footprint)) / 1048576 };
  try { run.reactorRun = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')); delete run.reactorRun.results; } catch {}
  run.ok = run.exit === 0 && run.bench.length > 0;
  writeFileSync(join(OUT, `${guest}-${String(index).padStart(2, '0')}.json`), JSON.stringify(run, null, 1));
  console.log(`cli ${guest} #${index}: ${run.ok ? 'ok' : 'FAILED exit ' + run.exit} ${run.bench.length} bench requests`);
  return run;
}

let failed = 0;
for (let i = FIRST; i < FIRST + RUNS; i++) for (const g of GUESTS) { const r = await oneRun(g, i); if (!r.ok) failed++; }
process.exit(failed ? 1 : 0);
