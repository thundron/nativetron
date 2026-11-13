// Regression tests of the native reactor host with the MOCK executor (no GPU): guards, poison, restart, and
// byte-identical crossing traces across the native, native-process and wasm guests (and against the prior wasm
// oracle trace when available). Real-GPU runs are e2e.sh's job.
//   node gpu/native/reactor/test.mjs
// Environment (defaults are the canonical engine outputs of /tmp/nt-native-reactor-1, read-only):
//   NT_REACTOR_BUILD_DIR, NT_REACTOR_ENGINE_DYLIB, NT_REACTOR_ENGINE_WASM_DIR, NT_REACTOR_ORACLE_TRACE,
//   NT_REACTOR_ROOT (scratch, default /tmp/nt-reactor-e2e/test), NT_REACTOR_HP (consumer sandbox for scenarios)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = process.env.NT_REACTOR_BUILD_DIR ?? '/tmp/nt-reactor-e2e/build';
const ENGINE = process.env.NT_REACTOR_ENGINE_DYLIB ?? '/tmp/nt-native-reactor-1/bin/libhp-engine.dylib';
const WASM = process.env.NT_REACTOR_ENGINE_WASM_DIR ?? '/tmp/nt-native-reactor-1/out/wasm';
const ORACLE = process.env.NT_REACTOR_ORACLE_TRACE ?? '/tmp/nt-native-reactor-1/proof/trace-wasm.txt';
const ROOT = process.env.NT_REACTOR_ROOT ?? '/tmp/nt-reactor-e2e/test';
const HP = process.env.NT_REACTOR_HP ?? '/tmp/nt-reactor-e2e/hp';
let failed = 0, passed = 0, skipped = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (cond) passed++; else failed++; };
const skip = (what) => { console.log(`skip ${what}`); skipped++; };

execFileSync(join(HERE, 'build.sh'), ['--out', BUILD], { stdio: ['ignore', 'ignore', 'inherit'] });
const CLI = join(BUILD, 'nt-reactor'), MOCK = join(BUILD, 'libntgpu-executor-mock.dylib');
if (!existsSync(ENGINE) || !existsSync(join(WASM, 'hp-engine.wasm'))) { skip(`engine artifacts missing (${ENGINE}, ${WASM})`); process.exit(0); }
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true });
const guests = { native: `native:${ENGINE}`, 'native-process': `native-process:${ENGINE}`, wasm: `wasm:${WASM}` };

// 1. guards, poison, restart, dead guest processes
for (const [name, spec] of Object.entries(guests)) {
  const r = spawnSync(CLI, ['selftest', '--engine', spec, '--executor-lib', MOCK], { encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter((l) => /^(PASS|FAIL|SKIP)/.test(l));
  ok(r.status === 0 && lines.length >= 6 && !lines.some((l) => l.startsWith('FAIL')), `selftest ${name}: ${lines.filter((l) => l.startsWith('PASS')).length} checks pass${lines.some((l) => l.startsWith('SKIP')) ? ' (in-process restart skipped by design)' : ''}`);
}

// 2. the prior oracle's export sequence: identical crossing traces for every guest
if (!existsSync(join(HP, 'packages/engine/src/format.ts'))) skip(`no consumer sandbox at ${HP} (sandbox.sh): scenario tests`);
else {
  const sc = join(ROOT, 'triangle-oracle');
  execFileSync('node', [join(HERE, 'scenario.mjs'), 'triangle-oracle', sc, '--hp', HP], { stdio: 'ignore' });
  const traces = {};
  for (const [name, spec] of Object.entries(guests)) {
    const out = join(ROOT, `oracle-${name}`);
    const r = spawnSync(CLI, ['run', '--engine', spec, '--executor-lib', MOCK, '--script', join(sc, 'script.txt'), '--out', out, '--trace', join(out, 'trace.txt'), '--trace-readback-sha'], { encoding: 'utf8' });
    ok(r.status === 0, `triangle-oracle ${name} runs (${r.stderr.trim().split('\n').pop()})`);
    traces[name] = existsSync(join(out, 'trace.txt')) ? readFileSync(join(out, 'trace.txt')) : Buffer.alloc(0);
  }
  ok(traces.native.length > 0 && traces.native.equals(traces.wasm) && traces.native.equals(traces['native-process']), 'native, native-process and wasm guests: byte-identical traces');
  if (existsSync(ORACLE)) ok(traces.native.equals(readFileSync(ORACLE)), `trace equals the prior wasm oracle (${ORACLE})`);
  else skip(`prior oracle trace ${ORACLE} absent`);

  // 3. capture path through the engine's T_CAPTURE (zero readbacks: the image is NOT a render)
  const tc = join(ROOT, 'triangle');
  execFileSync('node', [join(HERE, 'scenario.mjs'), 'triangle', tc, '--hp', HP], { stdio: 'ignore' });
  const out = join(ROOT, 'triangle-native');
  const r = spawnSync(CLI, ['run', '--engine', guests.native, '--executor-lib', MOCK, '--script', join(tc, 'script.txt'), '--out', out], { encoding: 'utf8' });
  const run = existsSync(join(out, 'run.json')) ? JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) : {};
  ok(r.status === 0 && run.executor?.mock === true && run.captures?.some((c) => c.name === 'triangle-engine' && c.width === 640),
    'engine capture assembled from E_CAPTURE_DATA chunks and labelled mock');
  ok(run.captures?.some((c) => c.name === 'triangle-executor' && c.unavailable), 'executor capture_rgba unavailable on the mock is reported, not faked');
}

// 4. recorded app sessions (record-app.mjs) replay identically on native and wasm guests
const recordings = join(dirname(HP), 'recordings');
for (const flow of ['golden', 'still', 'panorama', 'video']) {
  const rec = join(recordings, `bresso-living-${flow}`, 'recording.json');
  if (!existsSync(rec)) { skip(`no recording ${rec}`); continue; }
  const sc = join(ROOT, `app-${flow}`);
  execFileSync('node', [join(HERE, 'scenario.mjs'), 'app', sc, '--recording', rec, '--hp', HP], { stdio: 'ignore' });
  const t = {};
  for (const name of ['native', 'wasm']) {
    const out = join(ROOT, `app-${flow}-${name}`);
    const r = spawnSync(CLI, ['run', '--engine', guests[name], '--executor-lib', MOCK, '--width', '960', '--height', '600', '--script', join(sc, 'script.txt'), '--out', out, '--trace', join(out, 'trace.txt')], { encoding: 'utf8' });
    t[name] = r.status === 0 && existsSync(join(out, 'trace.txt')) ? readFileSync(join(out, 'trace.txt')) : null;
  }
  ok(t.native && t.wasm && t.native.equals(t.wasm), `app ${flow}: native and wasm replays complete with byte-identical traces`);
}
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
