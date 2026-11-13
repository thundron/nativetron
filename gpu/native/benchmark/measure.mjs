// Orchestrates one complete, uncontended measurement session (run only after the parent's gate):
//   environment + provenance → bundle → input recording → per power mode: app paths interleaved × runs, CLI
//   replays, executor shader-corpus compile → summary. Power-mode changes only with --allow-pmset (parent's gate):
//   AC "powermode" is switched with `sudo -n pmset -c powermode 1` (never a password prompt), verified through
//   ProcessInfo.isLowPowerModeEnabled (nt-bench-probe power), and the original value is restored in `finally` and on
//   SIGINT/SIGTERM, with `pmset -g custom` before/after recorded as evidence.
//
//   node gpu/native/benchmark/measure.mjs --root <R> --app <Nativetron executable> --reactor <nt-reactor>
//        --executor-lib <libntgpu-executor.dylib> --nativetron-commit <sha> --out <R>/runs
//        [--modes ac-high,low-power] [--runs 3] [--cli-runs 3] [--allow-pmset] [--paths wk-native,wk-native-overlay,chrome]
//        [--corpus-driver <ntgpu-executor-driver> --corpus /tmp/nt-native-gpu-shaders-20261113 --corpus-runs 3]
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const HERE = new URL('.', import.meta.url).pathname;
const ROOT = resolve(opt('--root', '/tmp/nt-native-gpu-measurements-root'));
const OUT = resolve(opt('--out', join(ROOT, 'runs')));
const APP = opt('--app'), REACTOR = opt('--reactor'), EXEC = opt('--executor-lib'), COMMIT = opt('--nativetron-commit', 'unknown');
const MODES = opt('--modes', 'ac-high').split(','), RUNS = Number(opt('--runs', 3)), CLI_RUNS = Number(opt('--cli-runs', 3));
const PATHS = opt('--paths', 'wk-native,wk-native-overlay,chrome').split(',');
const FIRST = Number(opt('--first-index', 0)); // supplementary sessions continue the run numbering (index 0 = cold)
const QUIET = opt('--wait-quiet'); // forwarded: wait for other GPU clients ≤ this ms/s before each run
const QW = QUIET ? ['--wait-quiet', QUIET] : [];
const ALLOW_PMSET = argv.includes('--allow-pmset');
const CORPUS_DRIVER = opt('--corpus-driver'), CORPUS = opt('--corpus', '/tmp/nt-native-gpu-shaders-20261113'), CORPUS_RUNS = Number(opt('--corpus-runs', 3));
const PROBE = join(ROOT, 'bin/nt-bench-probe');
const QUICK = argv.includes('--quick'); // harness validation only: tiny counts, never results
const Q = QUICK ? ['--quick'] : [];
const RECORDING = join(ROOT, QUICK ? 'recordings/bench-quick' : 'recordings/bench');
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, 'measure.log');
const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const sh = (cmd, args, o = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, ...o }); return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }; };
const power = () => JSON.parse(execFileSync(PROBE, ['power'], { encoding: 'utf8' }));
const sha = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null);
const node = (script, args, label) => {
  log(`$ node ${script} ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit', timeout: 4 * 3600e3 });
  if (r.status !== 0) log(`${label}: exit ${r.status}`);
  return r.status === 0;
};

// ---- environment + provenance
const ENV_FILE = join(OUT, FIRST ? `environment-from-${FIRST}.json` : 'environment.json');
const env = {
  startedAt: new Date().toISOString(), nativetronCommit: COMMIT, argv,
  host: { sw: sh('sw_vers', []).out, hw: sh('sysctl', ['-n', 'machdep.cpu.brand_string', 'hw.memsize', 'hw.ncpu']).out, gpu: sh('system_profiler', ['SPDisplaysDataType']).out.slice(0, 2000) },
  chrome: sh('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--version']).out.trim(), node: process.version,
  binaries: { app: { path: APP, sha256: sha(APP) }, reactor: { path: REACTOR, sha256: sha(REACTOR) }, executorLib: { path: EXEC, sha256: sha(EXEC) }, corpusDriver: CORPUS_DRIVER ? { path: CORPUS_DRIVER, sha256: sha(CORPUS_DRIVER) } : null,
    engineDylib: { path: '/tmp/nt-native-reactor-1/bin/libhp-engine.dylib', sha256: sha('/tmp/nt-native-reactor-1/bin/libhp-engine.dylib') },
    engineWasm: { path: join(ROOT, 'bundle/engine/hp-engine.wasm'), sha256: sha(join(ROOT, 'bundle/engine/hp-engine.wasm')) } },
  power: power(), pmsetCustom: sh('pmset', ['-g', 'custom']).out, pmset: sh('pmset', ['-g']).out, therm: sh('pmset', ['-g', 'therm']).out,
};
writeFileSync(ENV_FILE, JSON.stringify(env, null, 1));
log(`environment: lowPower=${env.power.isLowPowerModeEnabled} thermal=${env.power.thermalState} source=${env.power.providingPowerSource}`);

// ---- power-mode handling (restored in finally / on signals)
const acPowermode = () => { const m = /AC Power:[\s\S]*?\n\s*powermode\s+(\d+)/.exec(sh('pmset', ['-g', 'custom']).out); return m ? Number(m[1]) : null; };
const original = { acPowermode: acPowermode(), custom: env.pmsetCustom, power: env.power };
const evidence = { original: { acPowermode: original.acPowermode, isLowPowerModeEnabled: original.power.isLowPowerModeEnabled }, actions: [] };
let changed = false;
function restore(reason) {
  if (!changed) return;
  const r = sh('sudo', ['-n', '/usr/bin/pmset', '-c', 'powermode', String(original.acPowermode)]);
  evidence.actions.push({ at: new Date().toISOString(), action: `restore powermode ${original.acPowermode} (${reason})`, code: r.code, out: r.out.trim() });
  changed = r.code !== 0;
  for (let i = 0; i < 20 && power().isLowPowerModeEnabled !== original.power.isLowPowerModeEnabled; i++) spawnSync('sleep', ['0.5']);
  evidence.restored = { acPowermode: acPowermode(), power: power(), custom: sh('pmset', ['-g', 'custom']).out, identical: sh('pmset', ['-g', 'custom']).out === original.custom };
  writeFileSync(join(OUT, 'power-evidence.json'), JSON.stringify(evidence, null, 1));
  log(`power restored: powermode=${evidence.restored.acPowermode} lowPower=${evidence.restored.power.isLowPowerModeEnabled} pmset custom identical=${evidence.restored.identical}`);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(sig); process.exit(130); });
process.on('exit', () => restore('exit'));

function setLowPower() {
  if (!ALLOW_PMSET) return { ok: false, blocker: 'not authorized by the gate (--allow-pmset absent): low-power mode not entered' };
  const r = sh('sudo', ['-n', '/usr/bin/pmset', '-c', 'powermode', '1']);
  evidence.actions.push({ at: new Date().toISOString(), action: 'sudo -n pmset -c powermode 1', code: r.code, out: r.out.trim() });
  if (r.code !== 0) return { ok: false, blocker: `sudo -n pmset refused (exit ${r.code}): ${r.out.trim().slice(0, 300)}` };
  changed = true;
  let p = power();
  for (let i = 0; i < 40 && !p.isLowPowerModeEnabled; i++) { spawnSync('sleep', ['0.5']); p = power(); }
  evidence.lowPower = { power: p, custom: sh('pmset', ['-g', 'custom']).out };
  writeFileSync(join(OUT, 'power-evidence.json'), JSON.stringify(evidence, null, 1));
  return p.isLowPowerModeEnabled ? { ok: true, power: p } : { ok: false, blocker: 'pmset accepted but ProcessInfo.isLowPowerModeEnabled stayed false' };
}

const status = { modes: {} };
try {
  // ---- bundle + input recording (shared by every mode)
  if (!node('build-bundle.mjs', ['--sandbox', join(ROOT, 'sandbox'), '--out', join(ROOT, 'bundle'), '--nativetron-commit', COMMIT], 'bundle')) throw new Error('bundle build failed');
  if (!existsSync(join(RECORDING, 'recording.json')) && !node('record-bench.mjs', ['--root', ROOT, '--out', RECORDING, ...Q], 'record')) throw new Error('recording failed');
  for (const mode of MODES) {
    const st = status.modes[mode] = { startedAt: new Date().toISOString() };
    if (mode === 'low-power') {
      const lp = setLowPower();
      st.lowPower = lp;
      if (!lp.ok) { log(`low-power: BLOCKED — ${lp.blocker}`); continue; }
      log('low-power: ProcessInfo.isLowPowerModeEnabled = true; settling 20 s');
      spawnSync('sleep', ['20']);
    } else if (power().isLowPowerModeEnabled) { st.blocker = 'Low Power Mode is on before an ac-high run'; log(st.blocker); continue; }
    const app = join(OUT, mode, 'app'), cli = join(OUT, mode, 'cli');
    // interleaved: run i of every path before run i+1 (drift / thermal spread across paths, not into one)
    for (let i = FIRST; i < FIRST + RUNS; i++) for (const p of PATHS) node('run.mjs', ['--root', ROOT, '--out', app, '--path', p, '--runs', '1', '--first-index', String(i), '--label', mode, ...(p.startsWith('wk') ? ['--app', APP] : []), ...Q, ...QW], `${mode} ${p} #${i}`);
    if (CLI_RUNS > 0) node('cli-bench.mjs', ['--root', ROOT, '--recording', RECORDING, '--reactor', REACTOR, '--executor-lib', EXEC, '--out', cli, '--runs', String(CLI_RUNS), '--first-index', String(FIRST), '--label', mode, ...QW], `${mode} cli`);
    if (CORPUS_DRIVER) {
      const corpus = join(OUT, mode, 'corpus'); mkdirSync(corpus, { recursive: true });
      const times = [];
      for (let i = 0; i < CORPUS_RUNS; i++) {
        const t = process.hrtime.bigint();
        const r = spawnSync(process.execPath, [join(resolve(HERE, '..'), 'executor-corpus.mjs'), '--corpus', CORPUS, '--driver', CORPUS_DRIVER, '--out', join(corpus, `report-${i}.json`)], { encoding: 'utf8', timeout: 1800e3 });
        times.push({ index: i, wallMs: Number(process.hrtime.bigint() - t) / 1e6, exit: r.status, summary: (r.stdout ?? '').slice(-1500) });
        log(`${mode} corpus #${i}: ${times.at(-1).wallMs.toFixed(0)} ms exit ${r.status}`);
      }
      writeFileSync(join(corpus, 'timing.json'), JSON.stringify({ driver: CORPUS_DRIVER, corpus: CORPUS, note: '199 modules + every recorded pipeline shape through the executor (Naga → MSL → Metal), one driver process per run; wall includes process start and device creation', times }, null, 1));
    }
    if (mode === 'low-power') restore('low-power mode done');
    st.finishedAt = new Date().toISOString();
  }
} finally {
  restore('finally');
  status.finishedAt = new Date().toISOString();
  status.powerEnd = power();
  writeFileSync(join(OUT, FIRST ? `status-from-${FIRST}.json` : 'status.json'), JSON.stringify(status, null, 1));
  writeFileSync(join(OUT, FIRST ? `power-evidence-from-${FIRST}.json` : 'power-evidence.json'), JSON.stringify({ ...evidence, end: { acPowermode: acPowermode(), power: status.powerEnd, customIdentical: sh('pmset', ['-g', 'custom']).out === original.custom } }, null, 1));
  node('summarize.mjs', ['--runs', OUT, '--out', OUT], 'summary');
}
