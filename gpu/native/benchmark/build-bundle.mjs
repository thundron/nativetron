// Builds the house-planner production bundle that every compared app path loads (Chrome over loopback HTTP, the macOS
// host's WKWebView over app://dev), from a SANDBOX copy of the consumer — never the consumer checkout.
//
//   node gpu/native/benchmark/build-bundle.mjs --sandbox <root>/sandbox --nativetron-commit <sha> --out <root>/bundle
//
// <root>/sandbox/hp           the consumer at the commit the canonical engine wasm was built from (`git archive` +
//                             cloned node_modules + regenerated sources, see gpu/native/reactor/sandbox.sh)
// <root>/sandbox/nativetron   engine/ gpu/ ipc/ of the nativetron commit under test (`git archive <sha>`), the
//                             `node_modules/nativetron` link target: the bundled host JS is that commit's.
//
// One benchmark-only change, made at bundle time (the consumer's source stays byte-identical, even in the sandbox):
// `createEngine` from nativetron/engine/host.js is wrapped so that, when the page bootstrap (bootstrap.js, emitted
// here) claimed a native GPU session from the macOS host's `window.__ntNativeGpuOffer`, the lane gets
// `{ nativeGpu: { endpoint, session, postGeometry } }`. Without an offer (Chrome, WK without --native-gpu) the wrapper
// passes the app's options through unchanged, so all paths run the same bytes. The consumer has no native opt-in of
// its own; this wrapper is the documented substitute for that missing consumer switch.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SANDBOX = realpathSync(resolve(opt('--sandbox', '/tmp/nt-native-gpu-measurements-root/sandbox')));
const OUT = resolve(opt('--out', '/tmp/nt-native-gpu-measurements-root/bundle'));
const COMMIT = opt('--nativetron-commit', 'unknown');
const HP = join(SANDBOX, 'hp'), WEB = join(HP, 'apps/web');
const CONSUMER = '/Users/thundron/Documents/development/house-planner';
if (realpathSync(HP).startsWith(CONSUMER)) throw new Error('refusing to build in the consumer checkout');
const NT = realpathSync(join(HP, 'node_modules/nativetron'));
for (const f of [join(WEB, 'public/engine/hp-engine.wasm'), join(NT, 'engine/host.js'), join(NT, 'engine/native-gpu-wire.js')]) if (!existsSync(f)) throw new Error(`sandbox incomplete: ${f}`);

const WRAP_FROM = 'export function createEngine(options) {';
const nativeOptIn = {
  name: 'nt-bench-native-gpu-opt-in',
  enforce: 'post',
  transform(code, id) {
    if (!/nativetron\/engine\/host\.js$/.test(id)) return null;
    if (!code.includes(WRAP_FROM)) throw new Error('nativetron engine/host.js: createEngine signature changed; update the benchmark opt-in wrapper');
    const out = code.replace(WRAP_FROM, 'function __ntBenchCreateEngine(options) {') + `
// nativetron benchmark opt-in (gpu/native/benchmark/build-bundle.mjs): a session claimed by bootstrap.js
export function createEngine(options) {
  const claimed = globalThis.__ntBenchNativeGpu;
  if (!claimed || options.nativeGpu) return __ntBenchCreateEngine(options);
  globalThis.__ntBenchNativeGpuUsed = (globalThis.__ntBenchNativeGpuUsed ?? 0) + 1;
  return __ntBenchCreateEngine({ ...options, nativeGpu: { ...claimed, postGeometry: (g) => globalThis.webkit?.messageHandlers?.ntGpuSurface?.postMessage(g) } });
}
`;
    return { code: out, map: null };
  },
};

const viteDir = realpathSync(join(WEB, 'node_modules/vite'));
const vite = await import(pathToFileURL(join(viteDir, 'dist/node/index.js')).href);
rmSync(OUT, { recursive: true, force: true });
const tmp = join(SANDBOX, '.tmp'); mkdirSync(tmp, { recursive: true });
process.env.HP_SKIP_ENGINE = '1'; process.env.TMPDIR = tmp;
await vite.build({
  root: WEB, configFile: join(WEB, 'vite.config.ts'), cacheDir: join(tmp, 'vite-cache'), logLevel: 'warn',
  plugins: [nativeOptIn],
  build: { outDir: OUT, emptyOutDir: true, sourcemap: false, reportCompressedSize: false },
});

// bootstrap: claim (native host only) → import the app entry. Replaces the entry <script> in a copy of index.html.
const html = readFileSync(join(OUT, 'index.html'), 'utf8');
const entry = /<script type="module" crossorigin src="([^"]+)"><\/script>/.exec(html);
if (!entry) throw new Error('bundle index.html: module entry script not found');
cpSync(join(NT, 'engine/native-gpu-wire.js'), join(OUT, 'nt-bench/native-gpu-wire.js'));
cpSync(new URL('./driver.js', import.meta.url), join(OUT, 'nt-bench/driver.js'));
writeFileSync(join(OUT, 'nt-bench/bootstrap.js'), `// nativetron benchmark bootstrap (build-bundle.mjs): native GPU claim before the app's engine lane exists
import { claimNativeGpu } from './native-gpu-wire.js';
const t0 = performance.now();
// app://dev drops the query of --url: the runner writes the page parameters (the same for every path) to params.json
if (!location.search) {
  const p = await (await fetch('/nt-bench/params.json', { cache: 'no-store' })).json();
  history.replaceState(null, '', location.pathname + '?' + p.query);
}
let claimed = null, error = null;
try { claimed = await claimNativeGpu(window); } catch (e) { error = String(e?.message ?? e); }
globalThis.__ntBenchNativeGpu = claimed ? Object.freeze({ ...claimed }) : null;
globalThis.__ntBenchBoot = { claimMs: performance.now() - t0, native: Boolean(claimed), offer: Boolean(window.__ntNativeGpuOffer), error,
  composition: claimed?.composition ?? null, presentation: claimed?.presentation ?? null, executor: claimed?.executor ?? null };
console.log('NT_BENCH_BOOT ' + JSON.stringify(globalThis.__ntBenchBoot));
if (error) throw new Error(error);
await import(${JSON.stringify(entry[1])});
await import('./driver.js');
`);
writeFileSync(join(OUT, 'bench.html'), html.replace(entry[0], '<script type="module" src="/nt-bench/bootstrap.js"></script>'));

// provenance: every served file's sha256, the sandbox's consumer head and the nativetron commit
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(OUT);
const hashes = files.sort().map((p) => ({ path: relative(OUT, p), bytes: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') }));
const consumerHead = existsSync(join(SANDBOX, '../provenance/house-planner.head')) ? readFileSync(join(SANDBOX, '../provenance/house-planner.head'), 'utf8').trim() : 'unknown';
writeFileSync(join(SANDBOX, '../provenance/bundle.json'), JSON.stringify({ builtAt: new Date().toISOString(), nativetronCommit: COMMIT, consumerHead, out: OUT, files: hashes }, null, 1));
// app://dev serves only a folder owned by the user and not group/world-writable
const lock = (d) => { chmodSync(d, 0o755); for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) lock(p); else chmodSync(p, 0o644); } };
lock(OUT);
console.log(`bundle: ${hashes.length} files → ${OUT} (nativetron ${COMMIT}, consumer ${consumerHead})`);
