// Scenario compiler for nt-reactor: writes a step script (script.txt) and its payload files into a directory.
//   node scenario.mjs triangle-oracle <dir> [--hp <house-planner copy>]   the prior wasm oracle's sequence (regression)
//   node scenario.mjs triangle        <dir> [--hp …]                       the same plus engine + executor captures
//   node scenario.mjs app             <dir> --recording <recording.json> [--view <name>] [--capture raw|lossless|video]
//        a recorded house-planner session (record-app.mjs): the app's own engine frames, in order, then the capture
// Scenes and cameras come from the consumer's own encoders (packages/engine/src/format.ts, protocol.ts) in a
// read-only copy (default /tmp/nt-reactor-e2e/hp); engine frames use nativetron's ipc/engine.generated.mjs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeEngineMessage, ENGINE_BULK, ENGINE_COMMAND, LANE_UI, LANE_ENGINE } from '../../../ipc/engine.generated.mjs';

const argv = process.argv.slice(2);
const [kind, outDir] = argv;
const opt = (k, d) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
const HP = resolve(opt('--hp', '/tmp/nt-reactor-e2e/hp'));
if (!kind || !outDir) { console.error('usage: node scenario.mjs triangle-oracle|triangle|app <dir> [options]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const steps = [];
let blobs = 0;
const blob = (bytes, name = `blob-${blobs++}.bin`) => { writeFileSync(join(outDir, name), bytes); return `@${name}`; };
const u32s = (...v) => { const b = new Uint8Array(v.length * 4), d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x, true)); return b; };
const hex = (u8) => (u8.length ? `hex:${Buffer.from(u8).toString('hex')}` : '-');
const consumer = async (rel) => import(pathToFileURL(join(HP, rel)).href);

// constants from the consumer's protocol.ts (read at compile time, never copied by hand)
const P = await consumer('packages/engine/src/protocol.ts');

async function triangle(withCapture) {
  const F = await consumer('packages/engine/src/format.ts');
  const scene = F.encodeScene({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), meshes: new Uint32Array([0, 3, 0, 3]),
    matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]), instances: new Uint32Array([0, 0, 1, 0]),
    materials: new Float32Array(F.MATERIAL_FLOATS).fill(0.5), textures: new Uint8Array(1 * F.TEXTURE_SIZE * F.TEXTURE_SIZE * 4).fill(7),
    lights: new Float32Array(0), tileMaps: new Float32Array(F.TILEMAP_FLOATS), cells: new Uint32Array([1, 2, 3]),
    spaces: { originX: -1, originZ: -2, cell: 0.1, cols: 3, rows: 2, ids: new Uint8Array([0, 1, 1, 2, 2, 0]) }, bounds: new Float32Array([0, 0, 0, 1, 1, 0]),
  });
  const camera = F.encodeCamera({ eye: [0.5, 0.5, 3], target: [0.5, 0.3, 0], fovY: 60, near: 0.05 });
  // identical export sequence to the prior oracle (/tmp/nt-native-reactor-1/harness/wasm-run.mjs)
  steps.push('start', 'pump 6');
  steps.push(`message ${P.T_DEVICE} ${hex(u32s(1, 0))}`, 'pump 6');                       // desktop tier
  steps.push('resize 640 400 2', 'pump 6');                                              // RESIZE event (value = dpr)
  const [chunk] = P.sceneBulkChunks(scene, 1);
  steps.push(`receive ${blob(encodeEngineMessage(ENGINE_BULK, LANE_UI, LANE_ENGINE, 7, P.T_SCENE_BULK, chunk), 'scene-frame.bin')}`, 'pump 6');
  steps.push(`message ${P.T_CAMERA} ${hex(camera)}`, 'pump 6');
  if (withCapture) {
    steps.push('wait-result 7 600');
    steps.push(`receive ${blob(encodeEngineMessage(ENGINE_COMMAND, LANE_UI, LANE_ENGINE, 9, P.T_CAPTURE, u32s(0)), 'capture-frame.bin')}`);
    steps.push('wait-result 9 600', 'capture-engine 9 triangle-engine', 'capture-executor triangle-executor');
  }
}

// A recorded app session: every page → engine-worker frame in order, replayed frame-synchronously: before each
// frame the reactor renders exactly up to the engine frame count (E_STATUS frames) the page had seen when it sent
// it (`sync-frames`), so time-based page logic (settle waits, timeouts) becomes the engine frame it happened at.
// Commands whose result the page awaited are awaited; a GI run waits for its E_GI run event (view.ts runGi); every
// T_CAPTURE is written as `chrome-<request id>` (the recording keeps Chrome's bytes for the same request).
// --sync pump: the older heuristic (6 frames between frames, settled-status waits) for recordings without statuses.
function app() {
  const rec = JSON.parse(readFileSync(opt('--recording'), 'utf8'));
  const dir = opt('--recording').replace(/\/[^/]*$/, '');
  const frameBudget = Number(opt('--frames', 600));
  const sync = opt('--sync', 'frames');
  const resultIds = new Set(rec.results ?? []);
  const statuses = (rec.fromWorker ?? []).filter((e) => e.kind === 6 && e.topic === P.E_STATUS && e.frames !== undefined);
  const framesBefore = (t) => statuses.reduce((n, s) => (s.t <= t && s.frames > n ? s.frames : n), 0);
  steps.push(`mark recording:${rec.label ?? 'app'}`);
  steps.push('start', sync === 'frames' ? 'sync-frames 0' : 'pump 6');
  for (const m of rec.messages) {
    if (m.type !== 'resize' && m.type !== 'message' && m.type !== 'stream') continue;
    if (sync === 'frames') steps.push(`sync-frames ${framesBefore(m.t)}`);
    else if (m.settledBefore) steps.push(`wait-status ${P.STATUS_SETTLED} ${frameBudget}`);
    if (m.type === 'resize') { steps.push(`resize ${m.width} ${m.height} ${m.dpr}`); if (sync !== 'frames') steps.push('pump 6'); continue; }
    const bytes = readFileSync(join(dir, m.file));
    steps.push(`receive @${join(dir, m.file)}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kindByte = bytes[1], rid = view.getUint32(4, true), topic = view.getUint32(8, true);
    const giRun = topic === P.T_GI && m.giRun;
    if (giRun) steps.push(`wait-event ${P.E_GI} ${P.GI_EVENT_RUN} ${frameBudget}`);
    const capture = topic === P.T_CAPTURE && kindByte === ENGINE_COMMAND;
    if ((m.awaited || capture) && resultIds.has(rid) && (kindByte === ENGINE_COMMAND || kindByte === ENGINE_BULK)) steps.push(`wait-result ${rid} ${frameBudget}`);
    else if (!giRun && sync !== 'frames') steps.push('pump 6');
    if (capture) steps.push(`capture-engine ${rid} ${m.captureName ?? `chrome-${rid}`}`);
  }
  // --codec-probe: the engine's encoded capture paths (capture-codec.ts LOSSLESS for stills, VIDEO 4:2:0 for
  // walkthrough frames) on the final view, each its own T_CAPTURE (decoded by post.mjs with the consumer's codec)
  if (argv.includes('--codec-probe')) {
    const probe = (rid, codec, name) => {
      steps.push(`receive ${blob(encodeEngineMessage(ENGINE_COMMAND, LANE_UI, LANE_ENGINE, rid, P.T_CAPTURE, u32s(codec << P.CAPTURE_CODEC_SHIFT)), `${name}.bin`)}`);
      steps.push(`wait-result ${rid} ${frameBudget}`, `capture-engine ${rid} ${name}`);
    };
    probe(900001, 0, 'codec-raw');
    probe(900002, 1, 'codec-lossless');
    probe(900003, 2, 'codec-video');
  }
  steps.push('capture-executor executor-final');
}

if (kind === 'triangle-oracle') await triangle(false);
else if (kind === 'triangle') await triangle(true);
else if (kind === 'app') app();
else { console.error(`unknown scenario ${kind}`); process.exit(2); }
writeFileSync(join(outDir, 'script.txt'), `# generated by gpu/native/reactor/scenario.mjs ${argv.join(' ')}\n${steps.join('\n')}\n`);
console.log(join(outDir, 'script.txt'));
