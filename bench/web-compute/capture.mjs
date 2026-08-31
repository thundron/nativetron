import { instantiateFromBytes } from "./.scriptc/rows.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const chunks = { mount: [], update: [] };
let phase = "mount";
const api = await instantiateFromBytes(readFileSync("./.scriptc/rows.wasm"), {
  ntApply: (b) => { chunks[phase].push(Uint8Array.from(b)); },
});
api.nt_build(10000);
phase = "update";
api.nt_update();
const join = (arr) => { const n = arr.reduce((s, c) => s + c.length, 0); const out = new Uint8Array(n); let o = 0; for (const c of arr) { out.set(c, o); o += c.length; } return out; };
const m = join(chunks.mount), u = join(chunks.update);
writeFileSync("/tmp/mount.bin", m); writeFileSync("/tmp/update.bin", u);
console.log(`mount ${m.length} B in ${chunks.mount.length} flush(es); update ${u.length} B in ${chunks.update.length}`);
