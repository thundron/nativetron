import { instantiateFromBytes } from "./.scriptc/lane.mjs";
import { readFileSync } from "node:fs";
const N = +(process.argv[2] || 5000);
let lastJson = "", lastBin = null, jsonBytes = 0, binBytes = 0;
const api = await instantiateFromBytes(readFileSync("./.scriptc/lane.wasm"), {
  jsonOut: (s) => { lastJson = s; jsonBytes = s.length; },
  binOut: (b) => { lastBin = b.slice(); binBytes = b.byteLength; },
});
api.nt_setup(N);
const t = (f, r = 20) => { for (let i = 0; i < 3; i++) f(); const a = performance.now(); for (let i = 0; i < r; i++) f(); return (performance.now() - a) / r; };
const encBin = t(() => api.nt_fb());
const encJson = t(() => api.nt_fj());
// host side: what the webview must do with the JSON payload
const parse = t(() => JSON.parse(lastJson));
const nodes = Array.from({ length: N * 2 + 4 }, () => ({ textContent: "" }));
const applyJson = t(() => { const ops = JSON.parse(lastJson); for (const op of ops) if (op[0] === 3) nodes[op[1]].textContent = op[2]; });
// the desktop bridge evaluates `window.__nt.apply(<json>)` as SOURCE
globalThis.__sink = null;
// each frame is a DIFFERENT payload, so the engine cannot reuse a compiled
// script — vary the source per iteration or the number is a cache artifact
let ctr = 0;
const evalWrapped = t(() => { const src = "/*" + (ctr++) + "*/globalThis.__sink = " + lastJson + ";"; (0, eval)(src); }, 20);
const evalApply = t(() => {
  const src = "/*" + (ctr++) + "*/globalThis.__sink = " + lastJson + ";"; (0, eval)(src);
  for (const op of globalThis.__sink) if (op[0] === 3) nodes[op[1]].textContent = op[2];
}, 20);
const dv = () => new DataView(lastBin.buffer, lastBin.byteOffset, lastBin.byteLength);
const applyBin = t(() => {
  const d = dv(); let o = 0;
  while (o < lastBin.byteLength) {
    const code = lastBin[o++]; const id = d.getUint32(o, true); o += 4;
    if (code === 3) { const n = d.getUint32(o, true); o += 4; let s = ""; for (let q = o; q < o + n; q++) s += String.fromCharCode(lastBin[q]); o += n; nodes[id].textContent = s; }
  }
});
const f = (x) => x.toFixed(2).padStart(7);
console.log(`  ${N} text updates per frame`);
console.log(`                        guest encode   host apply    total   payload`);
console.log(`    binary (browser)   ${f(encBin)} ms  ${f(applyBin)} ms ${f(encBin+applyBin)} ms  ${(binBytes/1024).toFixed(0)} KB`);
console.log(`    JSON   (webview)   ${f(encJson)} ms  ${f(applyJson)} ms ${f(encJson+applyJson)} ms  ${(jsonBytes/1024).toFixed(0)} KB`);
console.log(`    JSON.parse alone   ${f(parse)} ms`);
console.log(`    eval() of source   ${f(evalWrapped)} ms   <- what the webview bridge actually does`);
console.log(`    eval + apply       ${f(evalApply)} ms  total ${f(encJson + evalApply)} ms`);
console.log(`    frame budget at 60fps: 16.67 ms`);
