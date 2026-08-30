import { instantiateFromBytes } from "./.scriptc/lane.mjs";
import { readFileSync } from "node:fs";
const N = +(process.argv[2] || 5000);
let lastBin = null;
const api = await instantiateFromBytes(readFileSync("./.scriptc/lane.wasm"), {
  binOut: (b) => { lastBin = b.slice(); },
});
api.nt_setup(N); api.nt_fb();
const nodes = Array.from({ length: N * 2 + 4 }, () => ({ textContent: "" }));
const t = (f, r = 20) => { for (let i = 0; i < 3; i++) f(); const a = performance.now(); for (let i = 0; i < r; i++) f(); return (performance.now() - a) / r; };
let ctr = 0;
const decodeBin = (u8) => {
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let o = 0;
  while (o < u8.byteLength) {
    const code = u8[o++]; const id = d.getUint32(o, true); o += 4;
    if (code === 3) { const n = d.getUint32(o, true); o += 4; let s = ""; for (let q = o; q < o + n; q++) s += String.fromCharCode(u8[q]); o += n; nodes[id].textContent = s; }
  }
};
const b64 = Buffer.from(lastBin).toString("base64");
const b64Eval = t(() => {
  const src = "/*" + (ctr++) + "*/globalThis.__b = \"" + b64 + "\";";
  (0, eval)(src);
  const bin = Uint8Array.from(Buffer.from(globalThis.__b, "base64"));
  decodeBin(bin);
});
const f = (x) => x.toFixed(2).padStart(7);
console.log(`  ${N} updates/frame`);
console.log(`    base64 binary   -> eval + apply   ${f(b64Eval)} ms   source ${(b64.length/1024).toFixed(0)} KB`);
const written = nodes.filter((n) => n.textContent !== "").length;
const sample = nodes.find((n) => n.textContent !== "");
console.log(`    nodes written: ${written} of ${N} expected, sample "${sample ? sample.textContent : ""}"`);
