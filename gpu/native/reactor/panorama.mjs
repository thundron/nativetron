// Composes a replayed panorama recording (record-app.mjs --flow panorama) the way the app does
// (apps/web/src/present/jobs.ts renderPanorama: six cube faces rendered FACE_MARGIN wider, centre-cropped, then
// equirectRows from the consumer's present/equirect.ts) and compares it with Chrome's composed result.
// The same composition applied to Chrome's own face captures must reproduce Chrome's result exactly (self-check).
//   node panorama.mjs <run dir> <recording dir> [--hp /tmp/nt-reactor-e2e/hp] [--width 512]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodePng, decodePng, compareRgba } from './png.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const [runDir, recDir] = argv;
const HP = resolve(opt('--hp', '/tmp/nt-reactor-e2e/hp'));
const rec = JSON.parse(readFileSync(join(recDir, 'recording.json'), 'utf8'));
const E = await import(pathToFileURL(join(HP, 'apps/web/src/present/equirect.ts')).href);
const width = Math.round(Number(opt('--width', 512)) / 2) * 2, height = width / 2, n = E.faceSizeFor(width);
// render.ts cropCentre
const crop = (img, w, h) => {
  const x0 = Math.floor((img.width - w) / 2), y0 = Math.floor((img.height - h) / 2), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.rgba.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return out;
};
const [eye, target] = rec.camera;
const forward = E.heading(eye, target), cams = E.cubeFaces(eye, forward);
const compose = (images) => {
  const faces = images.map((img, k) => ({ basis: E.faceBasis(cams[k].eye, cams[k].target), size: n, rgba: crop(img, n, n) }));
  const out = new Uint8Array(width * height * 4);
  E.equirectRows(faces, forward, width, height, out, 0, height);
  return { width, height, rgba: out };
};
const rids = rec.chromeCaptures.map((c) => c.rid).sort((a, b) => a - b);
if (rids.length !== 6) throw new Error(`expected 6 face captures, got ${rids.length}`);
const chromeFaces = rec.chromeCaptures.sort((a, b) => a.rid - b.rid).map((c) => ({ width: c.width, height: c.height, rgba: new Uint8Array(readFileSync(join(recDir, c.file))) }));
const chromeResult = decodePng(readFileSync(join(recDir, 'chrome-result.png')));
const self = compareRgba(compose(chromeFaces), chromeResult, 0);
console.log(`self-check (Chrome faces composed here vs Chrome's own panorama): ${self.notExact === 0 ? 'BIT-IDENTICAL' : `${self.notExact} px differ`}`);
const faces = rids.map((rid) => {
  const meta = JSON.parse(readFileSync(join(runDir, `chrome-${rid}.json`), 'utf8'));
  return { width: meta.width, height: meta.height, rgba: new Uint8Array(readFileSync(join(runDir, `chrome-${rid}.rgba`))) };
});
const pano = compose(faces);
writeFileSync(join(runDir, 'panorama.png'), encodePng(pano.width, pano.height, pano.rgba));
const c = compareRgba(pano, chromeResult, 12);
console.log(`panorama ${width}x${height} (faces ${n}px of ${faces[0].width}px renders) → ${join(runDir, 'panorama.png')}`);
console.log(`  vs Chrome panorama: ${c.differ} px > 12/255 (${(100 * c.differFraction).toFixed(4)} %), ${c.notExact} not bit-identical, max Δ ${c.maxDelta}, mean |Δ| ${c.meanAbs.toFixed(4)}`);
writeFileSync(join(runDir, 'panorama-compare.json'), JSON.stringify({ selfCheck: self, vsChrome: c, faceSize: n, width, height }, null, 1));
