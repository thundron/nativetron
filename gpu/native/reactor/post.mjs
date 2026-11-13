// Post-processing of nt-reactor runs: capture → PNG (codec captures decoded with the consumer's capture-codec.ts),
// comparisons against the Chrome baseline / committed golden and between runs (native vs wasm).
//   node post.mjs <run dir> [<run dir> …] [--golden <name>=<png>]… [--chrome <name>=<png>]… [--hp <sandbox>] [--out report.json]
// Tolerance (scripts/golden.mjs): a pixel differs when an RGB channel differs by > 12/255; a view fails above 0.5 %.
// A run whose executor is the MOCK is reported as such and never counted as a render.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodePng, decodePng, compareRgba } from './png.mjs';

const argv = process.argv.slice(2);
const runs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const multi = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : [])).map((s) => s.split('='));
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const HP = resolve(opt('--hp', '/tmp/nt-reactor-e2e/hp'));
const CHANNEL = 12, MAX_FRAC = 0.005;
const refs = { golden: Object.fromEntries(multi('--golden')), chrome: Object.fromEntries(multi('--chrome')) };
let codec = null;
// capture-codec.ts uses TypeScript syntax Node's type stripping rejects: transpile it with the sandbox's typescript
async function loadTs(path) {
  const { createRequire } = await import('node:module');
  const ts = createRequire(join(HP, 'package.json'))('typescript');
  const out = join(resolve(opt('--cache', '/tmp/nt-reactor-e2e/.cache')), path.replace(/[^A-Za-z0-9]+/g, '_') + '.mjs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  return import(pathToFileURL(out).href);
}
const load = async (dir, meta) => {
  if (meta.file === 'rgba') return { width: meta.width, height: meta.height, rgba: new Uint8Array(readFileSync(join(dir, `${meta.name}.rgba`))) };
  codec ??= await loadTs(join(HP, 'packages/engine/src/capture-codec.ts'));
  const bytes = new Uint8Array(readFileSync(join(dir, `${meta.name}.enc`)));
  return { width: meta.width, height: meta.height, rgba: codec.decodeCapture(bytes, meta.width, meta.height, meta.codec) };
};
const loadRef = (path) => (path.endsWith('.png') ? decodePng(readFileSync(path)) : null);
const verdict = (c) => (!c.comparable ? `not comparable (${c.reason})` : `${c.differ} px > ${CHANNEL}/255 (${(100 * c.differFraction).toFixed(4)} %, limit ${100 * MAX_FRAC} %), ${c.notExact} not bit-identical, max Δ ${c.maxDelta}, mean |Δ| ${c.meanAbs.toFixed(4)} → ${c.differFraction <= MAX_FRAC ? 'WITHIN' : 'OUTSIDE'} golden tolerance`);

const report = { tolerance: { channel: CHANNEL, maxFraction: MAX_FRAC }, runs: [], pairs: [] };
const images = new Map();
for (const dir of runs) {
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const entry = { dir, engine: run.engine, executor: run.executor, ok: run.ok, poisoned: run.poisoned, panic: run.panic, counters: run.counters, captures: [] };
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'run.json')) {
    const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!meta.width || !meta.source || !meta.name) continue; // capture metadata only (not panorama-compare.json etc.)
    const img = await load(dir, meta);
    writeFileSync(join(dir, `${meta.name}.png`), encodePng(img.width, img.height, img.rgba));
    const c = { name: meta.name, source: meta.source, width: img.width, height: img.height, mock: meta.executor.mock, png: join(dir, `${meta.name}.png`), compare: {} };
    for (const kind of ['golden', 'chrome']) {
      const ref = refs[kind][meta.name] && existsSync(refs[kind][meta.name]) ? loadRef(refs[kind][meta.name]) : null;
      if (ref) c.compare[kind] = { ref: refs[kind][meta.name], ...compareRgba(img, ref, CHANNEL) };
    }
    entry.captures.push(c);
    images.set(`${dir}::${meta.name}`, { img, mock: meta.executor.mock });
  }
  report.runs.push(entry);
}
// within a run: the codec probes against the raw capture of the same view (codec-raw)
for (const dir of runs) {
  const raw = images.get(`${dir}::codec-raw`);
  if (!raw) continue;
  for (const name of ['codec-lossless', 'codec-video']) {
    const b = images.get(`${dir}::${name}`);
    if (!b) continue;
    const identical = Buffer.compare(Buffer.from(raw.img.rgba), Buffer.from(b.img.rgba)) === 0;
    report.pairs.push({ a: `${dir}::codec-raw`, b: `${dir}::${name}`, name, identical, ...compareRgba(raw.img, b.img, CHANNEL) });
  }
}
// identical capture names across runs (native vs wasm vs process guests)
for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
  for (const [key, a] of images) {
    if (!key.startsWith(`${runs[i]}::`)) continue;
    const name = key.slice(runs[i].length + 2), b = images.get(`${runs[j]}::${name}`);
    if (!b) continue;
    const identical = a.img.rgba.length === b.img.rgba.length && Buffer.compare(Buffer.from(a.img.rgba), Buffer.from(b.img.rgba)) === 0;
    report.pairs.push({ a: runs[i], b: runs[j], name, identical, ...compareRgba(a.img, b.img, CHANNEL) });
  }
}
for (const r of report.runs) {
  console.log(`${r.dir}: ${r.ok ? 'ok' : 'FAILED'}${r.poisoned ? ` (poisoned: ${r.panic})` : ''}, executor ${r.executor.origin}${r.executor.mock ? ' [MOCK: not a render]' : ''}`);
  for (const c of r.captures) {
    console.log(`  ${c.name} ${c.width}x${c.height} ${c.source} → ${c.png}`);
    for (const [k, v] of Object.entries(c.compare)) console.log(`    vs ${k}: ${verdict(v)}`);
  }
}
for (const p of report.pairs) console.log(`pair ${p.name}: ${p.a} vs ${p.b}: ${p.identical ? 'BIT-IDENTICAL' : p.comparable && p.notExact === 0 ? 'RGB-IDENTICAL (alpha differs)' : verdict(p)}`);
if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(report, null, 1));
