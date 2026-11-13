// Records a real house-planner engine session in Chrome (WebGPU, the app's own wasm reactor in nativetron's engine
// worker) and writes every page → engine-worker frame, so nt-reactor can replay the app's exact engine input.
// Every capture the engine sends to the page (E_CAPTURE_DATA chunks + the T_CAPTURE result) is kept too: that is
// Chrome's baseline for the same request on this machine.
//
// Flows (all start like scripts/golden.mjs --engine at 960×600: settled(), setView; golden in the bare engine view
// `?engine&gidet&tier=desktop`, the others in the full app `?gidet&tier=desktop` where window.hpPresent lives):
//   golden    300 ms, runGi(64), capture()                       (the committed engine golden's procedure)
//   still     hpPresent.still({ width: 640, height: 400 })       (the app's still API: converged, raw capture)
//   panorama  hpPresent.panorama({ width: 512 })                 (six cube faces: meter, fixed exposure, stills)
//   video     hpPresent.video({ views: 2 saved views, height: 180, maxFrames: 4, framesPerStep: 4 }) (held steps)
//
// Runs ONLY against a sandbox copy of the consumer (default /tmp/nt-reactor-e2e/hp: `git archive` + cloned
// node_modules + nativetron link + the canonical engine wasm in apps/web/public/engine). Never the consumer checkout.
//   node record-app.mjs --out <dir> [--flow golden] [--hp /tmp/nt-reactor-e2e/hp] [--view living] [--port 5191] [--gi-frames 64]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodePng } from './png.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const HP = resolve(opt('--hp', '/tmp/nt-reactor-e2e/hp'));
const FLOW = opt('--flow', 'golden');
const VIEW = opt('--view', 'living');
const OUT = resolve(opt('--out', `/tmp/nt-reactor-e2e/recordings/bresso-${VIEW}-${FLOW}`));
const PORT = Number(opt('--port', 5191));
const GI_FRAMES = Number(opt('--gi-frames', 64));
const W = 960, H = 600;
const CONSUMER = '/Users/thundron/Documents/development/house-planner';
if (realpathSync(HP).startsWith(CONSUMER)) throw new Error('refusing to run against the consumer checkout; use a sandbox copy');
for (const f of ['apps/web/public/engine/hp-engine.wasm', 'node_modules/nativetron', 'scripts/golden.mjs']) if (!existsSync(join(HP, f))) throw new Error(`sandbox incomplete: ${f}`);
mkdirSync(join(OUT, 'frames'), { recursive: true });
mkdirSync(join(OUT, 'chrome-captures'), { recursive: true });

// the view's camera, read from the sandbox's scripts/golden.mjs (bresso scene)
const golden = readFileSync(join(HP, 'scripts/golden.mjs'), 'utf8');
const m = new RegExp(`\\b${VIEW}: \\[\\[([^\\]]+)\\], \\[([^\\]]+)\\]\\]`).exec(golden);
if (!m) throw new Error(`view ${VIEW} not in golden.mjs`);
const cam = [m[1].split(',').map(Number), m[2].split(',').map(Number)];

const tmp = join(resolve(OUT, '..'), '.tmp'); mkdirSync(tmp, { recursive: true });
const env = { ...process.env, HP_SKIP_ENGINE: '1', TMPDIR: tmp, XDG_CACHE_HOME: join(tmp, 'xdg') };
const viteBin = join(realpathSync(join(HP, 'apps/web/node_modules/vite')), 'bin/vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: join(HP, 'apps/web'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let viteLog = '';
vite.stdout.on('data', (d) => { viteLog += d; }); vite.stderr.on('data', (d) => { viteLog += d; });
const stopVite = () => { try { vite.kill('SIGTERM'); } catch {} };
process.on('exit', stopVite);
const BASE = `http://127.0.0.1:${PORT}/`;
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch {}
  if (i > 600 || vite.exitCode !== null) { console.error(viteLog); throw new Error('vite did not start'); }
  await new Promise((r) => setTimeout(r, 100));
}

const { default: puppeteer } = await import(pathToFileURL(createRequire(join(HP, 'scripts/golden.mjs')).resolve('puppeteer-core')).href);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  userDataDir: join(tmp, `chrome-profile-${FLOW}`), args: ['--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
const consoleLog = [];
page.on('console', (msg) => consoleLog.push(msg.text()));
page.on('pageerror', (e) => consoleLog.push(`pageerror ${e.message}`));
const failLogs = (error) => {
  writeFileSync(join(OUT, 'console.log'), consoleLog.join('\n') + '\n'); writeFileSync(join(OUT, 'vite.log'), viteLog);
  console.error(`recording failed: ${error?.stack ?? error}; logs in ${OUT}/console.log, vite.log`); stopVite(); process.exit(1);
};
process.on('unhandledRejection', failLogs);

const messages = [], fromWorker = [];
const chromeChunks = new Map(); // rid → [{offset, bytes}]
let seq = 0;
await page.exposeFunction('__ntRecord', (entry, b64) => {
  if (b64 !== null) {
    const file = `frames/${String(seq).padStart(5, '0')}.bin`;
    writeFileSync(join(OUT, file), Buffer.from(b64, 'base64'));
    entry.file = file;
  }
  entry.seq = seq++;
  messages.push(entry);
});
await page.exposeFunction('__ntFromWorker', (entry, b64) => {
  if (b64 !== null) {
    const p = Buffer.from(b64, 'base64');
    if (entry.kind === 7 && entry.topic === 100) { const list = chromeChunks.get(entry.rid) ?? []; list.push({ offset: p.readUInt32LE(0), bytes: p.subarray(4) }); chromeChunks.set(entry.rid, list); }
    else entry.payload = p.toString('hex');
  }
  fromWorker.push(entry);
});
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
            // E_STATUS: frames (f64 0) and flags (f64 6); results / errors / capture chunks keep their payload
            if (e.kind === 6 && e.topic === 102 && b.length >= 16 + 12 * 8) { e.frames = v.getFloat64(16, true); e.flags = v.getFloat64(16 + 48, true); e.ev = v.getFloat64(16 + 72, true); }
            else if (e.kind === 2 || e.kind === 3 || e.kind === 4 || (e.kind === 7 && e.topic === 100)) payload = b64(b.subarray(16));
          }
        }
        if (data.type === 'gpu-event') e.event = { type: data.event?.type, status: data.event?.status };
        if (data.type === 'failed' || data.type === 'error') e.message = `${data.code} ${data.message}`;
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
        if (data.type === 'frame-mode') e.mode = data.mode;
        window.__ntRecord(e, bytes);
      }
      return super.postMessage(data, transfer);
    }
  };
});

await page.setViewport({ width: W, height: H });
// golden: the bare engine view (as scripts/golden.mjs); the presentation APIs live in the full app (same engine flags)
const url = FLOW === 'golden' ? `${BASE}?engine&gidet&tier=desktop` : `${BASE}?gidet&tier=desktop`;
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.hpEngine, { timeout: 120000 }).catch(failLogs);
await page.evaluate(() => window.hpEngine.settled());
if (FLOW !== 'golden') await page.waitForFunction(() => window.hpPresent, { timeout: 60000 }).catch(failLogs);
const result = await page.evaluate(async (flow, cam, frames) => {
  const e = window.hpEngine, P = window.hpPresent;
  const pack = (img) => { let s = ''; for (let i = 0; i < img.rgba.length; i += 32768) s += String.fromCharCode.apply(null, img.rgba.subarray(i, i + 32768)); return { width: img.width, height: img.height, b64: btoa(s) }; };
  e.setView(cam[0], cam[1]);
  await new Promise((r) => setTimeout(r, 300));
  if (flow === 'golden') { await e.runGi(frames); return { image: pack(await e.capture()) }; }
  if (flow === 'still') { const png = await P.still({ width: 640, height: 400, samples: 1, format: 'png' }); return { pngBytes: png?.length ?? null }; }
  if (flow === 'panorama') return { image: pack(await P.panorama({ width: 512 })) };
  if (flow === 'video') {
    const views = (e.project?.views ?? []).slice(0, 2).map((v) => v.id);
    if (views.length < 2) return { error: `project has ${views.length} saved views` };
    const out = await P.video({ views, height: 180, maxFrames: 4, framesPerStep: 4 });
    return { views, video: out ? { type: out.type ?? null, bytes: out.bytes?.length ?? out.length ?? out.size ?? null } : null };
  }
  return { error: `unknown flow ${flow}` };
}, FLOW, cam, GI_FRAMES).catch(failLogs);
await new Promise((r) => setTimeout(r, 300));
await browser.close();
stopVite();
if (result?.error) failLogs(result.error);

// Chrome's own captures (the bytes the engine sent to the page for each T_CAPTURE request)
const chrome = [];
for (const r of fromWorker.filter((e) => e.type === 'message' && e.kind === 2 && e.topic === 7 && e.payload)) {
  const p = Buffer.from(r.payload, 'hex');
  if (p.length < 12) continue;
  const width = p.readUInt32LE(0), height = p.readUInt32LE(4), bgra = p.readUInt32LE(8), codec = p.length >= 20 ? p.readUInt32LE(12) : 0, encoded = p.length >= 20 ? p.readUInt32LE(16) : 0;
  const want = codec ? encoded : width * height * 4, bytes = Buffer.alloc(want);
  for (const c of chromeChunks.get(r.rid) ?? []) c.bytes.copy(bytes, c.offset);
  if (!codec && bgra === 1) for (let i = 0; i < want; i += 4) { const t = bytes[i]; bytes[i] = bytes[i + 2]; bytes[i + 2] = t; }
  const base = `chrome-captures/${r.rid}`;
  writeFileSync(join(OUT, `${base}.${codec ? 'enc' : 'rgba'}`), bytes);
  if (!codec) writeFileSync(join(OUT, `${base}.png`), encodePng(width, height, bytes));
  chrome.push({ rid: r.rid, width, height, codec, file: `${base}.${codec ? 'enc' : 'rgba'}`, png: codec ? null : `${base}.png`, sha256: createHash('sha256').update(bytes).digest('hex') });
}
if (result?.image) {
  const rgba = Buffer.from(result.image.b64, 'base64');
  writeFileSync(join(OUT, 'chrome-result.png'), encodePng(result.image.width, result.image.height, rgba));
}
// A page frame is "awaited" when its RESULT/ERROR reached the page before the page's next frame (causal order);
// "settledBefore": the page saw a new settled status (STATUS_SETTLED, 128) between the previous frame and this one.
const results = fromWorker.filter((e) => e.type === 'message' && (e.kind === 2 || e.kind === 3));
const statuses = fromWorker.filter((e) => e.kind === 6 && e.topic === 102 && e.flags !== undefined);
const ordered = messages.filter((e) => e.type === 'message' || e.type === 'stream' || e.type === 'resize');
for (let i = 0; i < ordered.length; i++) {
  const e = ordered[i], next = ordered[i + 1], prev = ordered[i - 1];
  if (e.rid) e.awaited = results.some((r) => r.rid === e.rid && (!next || r.t < next.t));
  if (prev) e.settledBefore = statuses.some((s) => s.t > prev.t && s.t <= e.t && (s.flags & 128) !== 0);
  if (e.file && e.kind === 1) {
    const p = readFileSync(join(OUT, e.file)).subarray(16), v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (e.topic === 11) e.giRun = p.length >= 28 && (v.getUint32(16, true) & 1) !== 0 && v.getUint32(24, true) > 0; // GI_RESTART + frames
    if (e.topic === 7) { e.captureFlags = p.length >= 4 ? v.getUint32(0, true) : 0; e.captureFrames = p.length >= 8 ? v.getUint32(4, true) : 1; e.captureName = `chrome-${e.rid}`; }
  }
}
const rec = {
  label: `bresso-${VIEW}-${FLOW}`, flow: FLOW, url, viewport: { width: W, height: H }, view: VIEW, camera: cam, giFrames: GI_FRAMES,
  wasm: createHash('sha256').update(readFileSync(join(HP, 'apps/web/public/engine/hp-engine.wasm'))).digest('hex'),
  messages: ordered.map(({ t, ...rest }) => ({ t: Math.round(t), ...rest })), control: messages.filter((e) => !ordered.includes(e)),
  results: [...new Set(results.map((r) => r.rid))], chromeCaptures: chrome, pageResult: result && { ...result, image: result.image ? { width: result.image.width, height: result.image.height } : undefined },
  fromWorker: fromWorker.filter((e) => !(e.kind === 7 && e.topic === 100)).map(({ payload, ...e }) => ({ ...e, t: Math.round(e.t), ...(payload && payload.length <= 512 ? { payload } : {}) })),
};
writeFileSync(join(OUT, 'recording.json'), JSON.stringify(rec, null, 1));
writeFileSync(join(OUT, 'console.log'), consoleLog.join('\n') + '\n');
writeFileSync(join(OUT, 'vite.log'), viteLog);
console.log(`${FLOW}: recorded ${ordered.length} engine frames/resizes (${rec.results.length} results, ${chrome.length} Chrome captures) → ${OUT}`);
process.exit(0);
