// Records the benchmark driver's house-planner session (full app, the same bundle and driver as the app paths) in
// headless Chrome, in the recording format of gpu/native/reactor/record-app.mjs (recording.json + frames/*.bin), so
// that gpu/native/reactor/scenario.mjs `app` replays the identical engine input — scene load, resize, LIVING view,
// the T_BENCH still / moving requests — through nt-reactor on the native executor (cli-bench.mjs). The recording run
// is input capture only; its timings are not results (headless, recorder overhead on every message).
//
//   node gpu/native/benchmark/record-bench.mjs --root <R> --out <R>/recordings/bench [--viewport 1100x760@2] [--query …]
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(opt('--root', '/tmp/nt-native-gpu-measurements-root'));
const OUT = resolve(opt('--out', join(ROOT, 'recordings/bench')));
const [VW, VH, VD] = (/^(\d+)x(\d+)@([\d.]+)$/.exec(opt('--viewport', '1100x760@2')) ?? []).slice(1).map(Number);
const QUERY = opt('--query', 'gidet&tier=desktop') + '&ntNoIdle' + (argv.includes('--quick') ? '&ntQuick' : '');
const BUNDLE = realpathSync(join(ROOT, 'bundle'));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'frames'), { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const p = resolve(BUNDLE, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(BUNDLE + '/') || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
writeFileSync(join(BUNDLE, 'nt-bench/params.json'), JSON.stringify({ query: QUERY }));

const req = createRequire(join(ROOT, 'sandbox/hp/scripts/golden.mjs'));
const { default: puppeteer } = await import(pathToFileURL(req.resolve('puppeteer-core')).href);
const profile = join(OUT, '.chrome-profile');
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile, protocolTimeout: 1800000, args: ['--no-first-run'] });
const page = await browser.newPage();
const consoleLog = [];
let doneResolve; const done = new Promise((r) => { doneResolve = r; });
page.on('console', (m) => { const t = m.text(); consoleLog.push(t); if (t.startsWith('NT_BENCH_DONE') || t.startsWith('NT_BENCH_ERROR')) doneResolve(t); });
page.on('pageerror', (e) => consoleLog.push(`pageerror ${e.message}`));
const messages = [], fromWorker = [];
let seq = 0;
await page.exposeFunction('__ntRecord', (entry, b64) => {
  if (b64 !== null) { const file = `frames/${String(seq).padStart(5, '0')}.bin`; writeFileSync(join(OUT, file), Buffer.from(b64, 'base64')); entry.file = file; }
  entry.seq = seq++; messages.push(entry);
});
await page.exposeFunction('__ntFromWorker', (entry, b64) => { if (b64 !== null) entry.payload = Buffer.from(b64, 'base64').toString('hex'); fromWorker.push(entry); });
// same instrumentation as record-app.mjs: the engine worker's messages in both directions (capture chunks not kept)
await page.evaluateOnNewDocument(() => {
  const ENGINE_TYPES = new Set(['probe', 'prepare', 'start', 'restart', 'message', 'stream', 'stream-ack', 'frame-mode', 'resize', 'stop']);
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
  const head = (u8) => { const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); return u8.length >= 16 ? { kind: u8[1], source: u8[2], target: u8[3], rid: v.getUint32(4, true), topic: v.getUint32(8, true), len: v.getUint32(12, true) } : {}; };
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      this.addEventListener('message', ({ data }) => {
        if (!data || typeof data.type !== 'string') return;
        const e = { t: performance.now(), type: data.type };
        let payload = null;
        if (data.type === 'message' || data.type === 'stream') {
          const b = data.bytes;
          if (b instanceof Uint8Array && b.length >= 16) {
            Object.assign(e, head(b));
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            if (e.kind === 6 && e.topic === 102 && b.length >= 16 + 12 * 8) { e.frames = v.getFloat64(16, true); e.flags = v.getFloat64(16 + 48, true); }
            else if ((e.kind === 2 || e.kind === 3 || e.kind === 4) && b.length <= 16 + 4096) payload = b64(b.subarray(16));
          }
        }
        window.__ntFromWorker(e, payload);
      });
    }
    postMessage(data, transfer) {
      if (data && ENGINE_TYPES.has(data.type)) {
        const e = { t: performance.now(), type: data.type, generation: data.generation };
        let bytes = null;
        if ((data.type === 'message' || data.type === 'stream') && data.bytes instanceof Uint8Array) { Object.assign(e, head(data.bytes)); bytes = b64(new Uint8Array(data.bytes)); }
        if (data.type === 'resize') Object.assign(e, { width: data.width, height: data.height, dpr: data.dpr });
        if (data.type === 'start' || data.type === 'restart' || data.type === 'prepare') e.options = JSON.parse(JSON.stringify(data.options ?? {}));
        window.__ntRecord(e, bytes);
      }
      return super.postMessage(data, transfer);
    }
  };
});
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: VD });
await page.goto(`http://${server.address().address}:${server.address().port}/bench.html`, { waitUntil: 'load' });
const end = await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout'), 1500000))]);
await new Promise((r) => setTimeout(r, 300));
await browser.close(); server.close(); rmSync(profile, { recursive: true, force: true });
if (!String(end).startsWith('NT_BENCH_DONE')) { writeFileSync(join(OUT, 'console.log'), consoleLog.join('\n')); throw new Error(`recording failed: ${end}`); }

// record-app.mjs's derived fields: awaited results, GI runs, captures
const results = fromWorker.filter((e) => e.type === 'message' && (e.kind === 2 || e.kind === 3));
const ordered = messages.filter((e) => e.type === 'message' || e.type === 'stream' || e.type === 'resize');
const statuses = fromWorker.filter((e) => e.kind === 6 && e.topic === 102 && e.flags !== undefined);
for (let i = 0; i < ordered.length; i++) {
  const e = ordered[i], next = ordered[i + 1], prev = ordered[i - 1];
  if (e.rid) e.awaited = results.some((r) => r.rid === e.rid && (!next || r.t < next.t));
  if (prev) e.settledBefore = statuses.some((s) => s.t > prev.t && s.t <= e.t && (s.flags & 128) !== 0);
  if (e.file && e.kind === 1) {
    const p = readFileSync(join(OUT, e.file)).subarray(16), v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (e.topic === 11) e.giRun = p.length >= 28 && (v.getUint32(16, true) & 1) !== 0 && v.getUint32(24, true) > 0;
    if (e.topic === 6) { e.benchFrames = p.length >= 4 ? v.getUint32(0, true) : 0; e.benchFlags = p.length >= 8 ? v.getUint32(4, true) : 0; }
    if (e.topic === 7) { e.captureFlags = p.length >= 4 ? v.getUint32(0, true) : 0; e.captureFrames = p.length >= 8 ? v.getUint32(4, true) : 1; e.captureName = `chrome-${e.rid}`; }
  }
}
const resultTimes = new Map(results.map((r) => [r.rid, r.t]));
const rec = {
  label: 'bresso-full-app-bench', flow: 'bench', url: `bench.html?${QUERY}`, viewport: { width: VW, height: VH, dpr: VD },
  wasm: createHash('sha256').update(readFileSync(join(BUNDLE, 'engine/hp-engine.wasm'))).digest('hex'),
  messages: ordered.map(({ t, ...rest }) => ({ t: Math.round(t), ...rest, ...(rest.benchFrames !== undefined && resultTimes.has(rest.rid) ? { chromeHeadlessMs: +(resultTimes.get(rest.rid) - t).toFixed(2) } : {}) })),
  control: messages.filter((e) => !ordered.includes(e)), results: [...new Set(results.map((r) => r.rid))], chromeCaptures: [],
  fromWorker: fromWorker.map(({ payload, ...e }) => ({ ...e, t: Math.round(e.t), ...(payload && payload.length <= 512 ? { payload } : {}) })),
};
writeFileSync(join(OUT, 'recording.json'), JSON.stringify(rec, null, 1));
writeFileSync(join(OUT, 'console.log'), consoleLog.join('\n') + '\n');
const bench = rec.messages.filter((m) => m.benchFrames !== undefined);
console.log(`bench recording: ${ordered.length} engine frames/resizes, ${bench.length} T_BENCH requests (${bench.map((b) => `${b.benchFrames}${b.benchFlags & 1 ? 'm' : 's'}`).join(' ')}) → ${OUT}`);
process.exit(0);
