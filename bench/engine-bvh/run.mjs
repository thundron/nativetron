import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import * as js from "./workload.ts";
import { instantiateFromBytes } from "./.scriptc/workload.mjs";

assert.equal(process.version, "v24.22.1", "use the official Node 24.22.1 distribution");
assert.equal(process.versions.icu, "78.3", "Homebrew's different ICU build is not this benchmark oracle");
const triangles = 50000, warmups = 5, trials = Number(process.env.TRIALS ?? 21);
assert.ok(Number.isInteger(trials) && trials >= 5);
const bytes = readFileSync(new URL("./.scriptc/workload.wasm", import.meta.url));
const wasm = await instantiateFromBytes(bytes, {});
js.prepare(triangles); wasm.bvh_prepare(triangles);
const times = { buildJs: [], buildWasm: [], refitJs: [], refitWasm: [] };
const timed = (fn) => { const start = performance.now(); const result = fn(); return { ms: performance.now() - start, result }; };
let checksum;
for (let trial = -warmups; trial < trials; trial++) {
  let buildJs, buildWasm, refitJs, refitWasm;
  if (trial & 1) { buildWasm = timed(() => wasm.bvh_build()); buildJs = timed(() => js.build()); }
  else { buildJs = timed(() => js.build()); buildWasm = timed(() => wasm.bvh_build()); }
  assert.equal(buildJs.result, triangles * 2 - 1); assert.equal(buildWasm.result, buildJs.result);
  assert.equal(js.validate(), 1); assert.equal(wasm.bvh_validate(), 1);
  checksum = js.checksum(); assert.equal(wasm.bvh_checksum(), checksum, "full tree/order checksum");
  if (trial & 1) { refitWasm = timed(() => wasm.bvh_refit()); refitJs = timed(() => js.refit()); }
  else { refitJs = timed(() => js.refit()); refitWasm = timed(() => wasm.bvh_refit()); }
  assert.equal(refitWasm.result, refitJs.result);
  assert.equal(js.validate(), 1); assert.equal(wasm.bvh_validate(), 1);
  assert.equal(js.checksum(), checksum); assert.equal(wasm.bvh_checksum(), checksum);
  if (trial >= 0) {
    for (const [key, sample] of Object.entries({ buildJs, buildWasm, refitJs, refitWasm })) times[key].push(sample.ms);
  }
}
for (const [left, right] of [[1.1, 3.7], [1e-20, 1e20], [-3.14159, 9.123]]) assert.equal(wasm.bvh_f32Probe(left, right), js.f32Probe(left, right));
js.perturb(); wasm.bvh_perturb(); js.refit(); wasm.bvh_refit();
assert.equal(js.validate(), 1); assert.equal(wasm.bvh_validate(), 1);
assert.equal(wasm.bvh_checksum(), js.checksum()); assert.notEqual(js.checksum(), checksum);
const summarize = (values) => {
  const sorted = [...values].sort((a,b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)], minMs: sorted[0], maxMs: sorted.at(-1) };
};
const report = {
  date: new Date().toISOString(), node: process.version, v8: process.versions.v8, icu: process.versions.icu,
  system: { platform: platform(), arch: arch(), cpu: cpus()[0].model },
  triangles, bins: 16, nodes: triangles * 2 - 1, checksum, warmups, trials,
  pairedInterleaved: true, correctnessGated: true, deformedRefitValidated: true,
  build: { v8: summarize(times.buildJs), wasm: summarize(times.buildWasm) },
  refit: { v8: summarize(times.refitJs), wasm: summarize(times.refitWasm) },
  moduleBytes: bytes.length, linearMemoryBytes: wasm.__memory().byteLength, samples: times,
};
writeFileSync(new URL("./last-run.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
