// App-path runner: loads the SAME house-planner bundle (build-bundle.mjs) in one app path per process launch, lets the
// in-page driver (driver.js) run its fixed procedure, samples every process of that launch on each driver mark
// (nt-bench-probe serve: CPU ns, kernel GPU ns per process, phys_footprint, wakeups) and writes one raw JSON per run.
//
//   node gpu/native/benchmark/run.mjs --root <R> --out <dir> --path chrome|wk-native|wk-native-overlay|wk-webgpu
//        [--runs 3] [--app <Nativetron.app/Contents/MacOS/Nativetron>] [--query 'gidet&tier=desktop'] [--quick]
//        [--viewport 1100x760@2] [--chrome-profile fresh-then-warm|fresh] [--label ac-high]
//
// Paths (every one: same bundle bytes, same wasm reactor in nativetron's engine Worker, same driver):
//   chrome             Google Chrome (headed, visible window, fresh process per run) → Dawn/Metal (JS WebGPU)
//   wk-native          macOS host WKWebView, --native-gpu (headless executor, nothing presented: the host has no
//                      public transparent composition) → binary WKURLSchemeHandler wire → wgpu-native/Metal executor
//   wk-native-overlay  same with --native-gpu-composition=overlay (CAMetalLayer above the web view, public API)
//   wk-webgpu          macOS host WKWebView without --native-gpu → WebKit's own WebGPU (if the page gets an adapter)
// Cache tags per run: chrome profile `fresh` (empty user-data-dir: Chrome's shader/pipeline disk caches cold) or `warm`
// (the previous run's profile); the OS Metal compiler cache is per bundle id and is NOT cleared (state recorded).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(opt('--root', '/tmp/nt-native-gpu-measurements-root'));
const PATH = opt('--path', 'chrome');
const RUNS = Number(opt('--runs', 1));
const FIRST = Number(opt('--first-index', 0)); // run indices FIRST…FIRST+RUNS-1 (index 0: fresh Chrome profile)
const OUT = resolve(opt('--out', join(ROOT, 'runs', 'adhoc')));
const APP = opt('--app', '');
const QUICK = argv.includes('--quick');
const QUERY = opt('--query', 'gidet&tier=desktop') + (QUICK ? '&ntQuick' : '');
const [VW, VH, VD] = (/^(\d+)x(\d+)@([\d.]+)$/.exec(opt('--viewport', '1100x760@2')) ?? []).slice(1).map(Number);
const PROFILE_MODE = opt('--chrome-profile', 'fresh-then-warm');
const LABEL = opt('--label', 'adhoc');
const BUNDLE = join(ROOT, 'bundle');
const PROBE = join(ROOT, 'bin/nt-bench-probe');
const TIMEOUT_MS = Number(opt('--timeout-ms', QUICK ? 300000 : 1200000));
if (!['chrome', 'wk-native', 'wk-native-overlay', 'wk-webgpu'].includes(PATH)) throw new Error(`unknown --path ${PATH}`);
if (PATH.startsWith('wk') && !existsSync(APP)) throw new Error('--app <Nativetron executable> required for WK paths');
for (const f of [join(BUNDLE, 'bench.html'), PROBE]) if (!existsSync(f)) throw new Error(`missing ${f}`);
mkdirSync(OUT, { recursive: true });

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }); } catch (e) { return `ERROR ${e.message}`; } };
const power = () => { try { return JSON.parse(execFileSync(PROBE, ['power'], { encoding: 'utf8' })); } catch (e) { return { error: String(e) }; } };
const procTable = () => sh('ps', ['-A', '-o', 'pid=,ppid=,comm=']).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], comm: m[3] }));
const descendants = (root) => { const t = procTable(), out = new Set([root]); let grew = true; while (grew) { grew = false; for (const p of t) if (out.has(p.ppid) && !out.has(p.pid)) { out.add(p.pid); grew = true; } } return [...out]; };
const webkitPids = () => procTable().filter((p) => /com\.apple\.WebKit\./.test(p.comm)).map((p) => p.pid);
const metalCache = () => {
  const dir = join(sh('getconf', ['DARWIN_USER_CACHE_DIR']).trim(), 'dev.nativetron.macos', 'com.apple.metal');
  return { dir, exists: existsSync(dir), du: existsSync(dir) ? sh('du', ['-sk', dir]).trim() : null };
};
const dirSize = (d) => existsSync(d) ? Number(sh('du', ['-sk', d]).split(/\s/)[0]) : 0;

// one long-lived probe (answers a line of pids with one JSON line)
const probe = spawn(PROBE, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
const probeLines = createInterface({ input: probe.stdout });
const probeWait = [];
probeLines.on('line', (l) => probeWait.shift()?.(JSON.parse(l)));
const sample = (pids) => new Promise((r) => { probeWait.push(r); probe.stdin.write(pids.join(',') + '\n'); });

/** GPU-time of every Metal client over `ms` (contention: who else used the GPU), and the top CPU processes. */
async function contention(ms = 2000) {
  const a = await sample([]); await new Promise((r) => setTimeout(r, ms)); const b = await sample([]);
  const gpu = Object.entries(b.gpu_all).map(([pid, ns]) => ({ pid: +pid, gpuMsPerS: (ns - (a.gpu_all[pid] ?? ns)) / 1e6 / (ms / 1000) })).filter((x) => x.gpuMsPerS > 0.5).sort((x, y) => y.gpuMsPerS - x.gpuMsPerS);
  const names = new Map(procTable().map((p) => [p.pid, p.comm]));
  for (const g of gpu) g.comm = names.get(g.pid) ?? '?';
  const cpu = sh('ps', ['-A', '-r', '-o', 'pid=,pcpu=,comm=']).split('\n').slice(0, 8).map((l) => l.trim()).filter(Boolean);
  return { windowMs: ms, gpuClients: gpu, topCpu: cpu, load: sh('sysctl', ['-n', 'vm.loadavg']).trim() };
}

// loopback static server for Chrome (the same files app://dev serves to WK)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const BUNDLE_REAL = realpathSync(BUNDLE);
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = resolve(BUNDLE_REAL, '.' + decodeURIComponent(u.pathname));
  if (!p.startsWith(BUNDLE_REAL + '/') || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

writeFileSync(join(BUNDLE, 'nt-bench/params.json'), JSON.stringify({ query: QUERY }));
const bundleHash = createHash('sha256').update(readFileSync(join(ROOT, 'provenance/bundle.json'))).digest('hex');

async function oneRun(index) {
  const run = { schema: 'nt-bench-run/1', label: LABEL, path: PATH, index, quick: QUICK, query: QUERY, startedAt: new Date().toISOString(),
    viewport: { width: VW, height: VH, dpr: VD }, bundleManifestSha256: bundleHash, app: PATH.startsWith('wk') ? APP : null, power: {}, contention: {}, samples: [], lines: [] };
  run.power.before = power(); run.power.thermBefore = sh('pmset', ['-g', 'therm']).trim(); run.power.pmsetBefore = sh('pmset', ['-g']).trim();
  run.contention.before = await contention();
  let pids = [], target = null, browser = null, chromeProfile = null;
  const parts = []; let done = null, failed = null, boot = null;
  const t0 = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
  let resolveDone; const finished = new Promise((r) => { resolveDone = r; });
  const pidSet = () => pids;
  const onLine = async (text) => {
    if (!text.startsWith('NT_BENCH_') && !text.startsWith('HP_') && !text.startsWith('ENGINE')) return;
    run.lines.push({ hostMs: ms(), text: text.startsWith('NT_BENCH_PART') ? text.slice(0, 40) : text.slice(0, 600) });
    if (text.startsWith('NT_BENCH_BOOT ')) { boot = JSON.parse(text.slice(14)); run.bootHostMs = ms(); }
    else if (text.startsWith('NT_BENCH_MARK ')) {
      const m = JSON.parse(text.slice(14));
      if (PATH.startsWith('wk')) pids = [...new Set([target.pid, ...webkitPids().filter((p) => !pre.has(p))])];
      else pids = descendants(browser.process().pid);
      run.samples.push({ mark: m, hostMs: ms(), probe: await sample(pidSet()) });
    } else if (text.startsWith('NT_BENCH_PART ')) { const m = /^NT_BENCH_PART (\d+)\/(\d+) (.*)$/.exec(text); parts[+m[1] - 1] = m[3]; }
    else if (text.startsWith('NT_BENCH_DONE ')) { done = parts.join(''); resolveDone(); }
    else if (text.startsWith('NT_BENCH_ERROR ')) failed = text.slice(15);
  };
  const pre = new Set(webkitPids());
  if (PATH === 'chrome') {
    const req = createRequire(join(ROOT, 'sandbox/hp/scripts/golden.mjs'));
    const { default: puppeteer } = await import(pathToFileURL(req.resolve('puppeteer-core')).href);
    chromeProfile = join(OUT, 'chrome-profile');
    const fresh = PROFILE_MODE === 'fresh' || index === 0 || !existsSync(chromeProfile);
    if (fresh) rmSync(chromeProfile, { recursive: true, force: true });
    run.cache = { chromeProfile: fresh ? 'fresh' : 'warm', chromeProfileKBBefore: dirSize(chromeProfile) };
    browser = await puppeteer.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false, userDataDir: chromeProfile, defaultViewport: null,
      protocolTimeout: TIMEOUT_MS,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--window-size=${VW + 40},${VH + 160}`],
    });
    run.chromeVersion = await browser.version();
    const page = (await browser.pages())[0] ?? await browser.newPage();
    await page.setViewport({ width: VW, height: VH, deviceScaleFactor: VD });
    page.on('console', (m) => void onLine(m.text()));
    page.on('pageerror', (e) => run.lines.push({ hostMs: ms(), text: `pageerror ${e.message}`.slice(0, 600) }));
    pids = descendants(browser.process().pid);
    run.launchHostMs = ms();
    await page.goto(`http://127.0.0.1:${PORT}/bench.html`, { waitUntil: 'load' });
  } else {
    run.cache = { metalCacheBefore: metalCache() };
    const args = [`--benchmark-viewport=${VW}x${VH}`, ...(PATH === 'wk-webgpu' ? [] : ['--native-gpu'])];
    if (PATH === 'wk-native-overlay') args.push('--native-gpu-composition=overlay');
    args.push('--url', pathToFileURL(join(BUNDLE, 'bench.html')).href);
    run.appArgs = args;
    target = spawn(APP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    run.launchHostMs = ms();
    pids = [target.pid];
    const host = [];
    const take = (stream) => createInterface({ input: stream }).on('line', (l) => {
      if (l.startsWith('NT_MACOS_CONSOLE ')) void onLine(l.slice(17));
      else {
        host.push(l.slice(0, 1000)); if (host.length > 400) host.shift();
        if (l.startsWith('NT_MACOS_BENCHMARK_VIEWPORT ')) run.hostViewport = l.slice(28);
      }
    });
    take(target.stdout); take(target.stderr);
    target.on('exit', (code, sig) => { run.appExit = { code, sig, hostMs: ms() }; resolveDone(); });
    run.hostLines = host;
  }
  const timer = setTimeout(() => { failed ??= `timeout after ${TIMEOUT_MS} ms`; resolveDone(); }, TIMEOUT_MS);
  await finished; clearTimeout(timer);
  run.totalHostMs = ms();
  run.boot = boot;
  try { run.driver = done ? JSON.parse(done) : null; } catch (e) { failed ??= `driver JSON: ${e}`; }
  if (run.driver?.error) failed ??= run.driver.error;
  run.final = await sample(pidSet());
  if (browser) { await browser.close().catch(() => {}); run.cache.chromeProfileKBAfter = dirSize(chromeProfile); }
  if (target && target.exitCode === null) {
    target.kill('SIGTERM');
    await new Promise((r) => { const k = setTimeout(() => { target.kill('SIGKILL'); r(); }, 5000); target.once('exit', () => { clearTimeout(k); r(); }); });
  }
  if (PATH.startsWith('wk')) run.cache.metalCacheAfter = metalCache();
  run.power.after = power(); run.power.thermAfter = sh('pmset', ['-g', 'therm']).trim();
  run.contention.after = await contention();
  run.ok = !failed && Boolean(run.driver);
  run.error = failed;
  const file = join(OUT, `${PATH}-${String(index).padStart(2, '0')}.json`);
  writeFileSync(file, JSON.stringify(run, null, 1));
  console.log(`${PATH} #${index}: ${run.ok ? 'ok' : 'FAILED ' + failed} (${(run.totalHostMs / 1000).toFixed(1)} s) → ${file}`);
  return run;
}

let failures = 0;
try {
  for (let i = FIRST; i < FIRST + RUNS; i++) { const r = await oneRun(i); if (!r.ok) failures++; await new Promise((r) => setTimeout(r, 3000)); }
} finally {
  server.close(); probe.stdin.end(); probe.kill();
}
process.exit(failures ? 1 : 0);
