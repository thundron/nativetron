import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const glue = await import("./.scriptc/ops.mjs");
const wasm = readFileSync("./.scriptc/ops.wasm");
const api = await glue.instantiateFromBytes(wasm, {});
const js = await import("./ops.ts");

// op -> input size n. Sizes chosen so one call is tens-of-us to low-ms.
const SIZES = {
  arrPush: 20000, arrPop: 20000, arrShift: 8000, arrUnshift: 8000,
  arrIndexOf: 2000, arrIncludes: 2000, arrSlice: 5000, arrSplice: 6000,
  arrConcat: 2000, arrJoin: 5000, arrMap: 5000, arrFilter: 5000,
  arrReduce: 5000, arrForEach: 5000, arrFind: 2000, arrSome: 2000,
  arrEvery: 5000, arrReverse: 5000, arrSort: 2000,
  numIntLoop: 10000, numFloatMath: 10000, numMathCalls: 200000, numBitOps: 10000,
  objFieldRW: 200000, objLiteral: 200000, objSpread: 200000,
  strBuild: 20000, strIndexOf: 3000, strIncludes: 3000, strSlice: 4000,
  strSubstring: 4000, strSplit: 3000, strJoin: 5000, strTrim: 4000,
  strStartsWith: 2000, strEndsWith: 2000, strRepeat: 200, strCharCodeAt: 3000,
  strCompare: 5000, strTemplate: 100000, strNumToStr: 100000, strStrToNum: 100000,
  mapSet: 20000, mapGet: 20000, mapHas: 20000, mapDelete: 20000, mapIterate: 5000,
  setAdd: 20000, setHas: 20000,
  jsonStringify: 2000, jsonParse: 2000,
  allocObjects: 200000, allocArrays: 200000, allocStrings: 100000,
};

const REPS = Number(process.env.REPS ?? 201);
const WARM = Number(process.env.WARM ?? 40);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const lo = (xs) => Math.min(...xs);
const hi = (xs) => Math.max(...xs);

function timeFn(fn, n, reps) {
  const ts = new Array(reps);
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn(n);
    ts[i] = performance.now() - t0;
  }
  return ts;
}

const rows = [];
const mism = [];
const names = Object.keys(SIZES);

for (const name of names) {
  const n = SIZES[name];
  const wfn = api["nt_" + name];
  const jfn = js[name];
  if (!wfn) { console.error("missing wasm export", name); continue; }
  // correctness
  const cw = wfn(n), cj = jfn(n);
  const ok = cw === cj || (Number.isFinite(cw) && Number.isFinite(cj) && Math.abs(cw - cj) <= Math.abs(cj) * 1e-12 + 1e-6);
  if (!ok) mism.push({ name, n, wasm: cw, v8: cj });
  // warmup both (also warms wasm from baseline tier to hot)
  for (let i = 0; i < WARM; i++) { wfn(n); jfn(n); }
  // interleaved paired timing
  const wt = [], jt = [];
  for (let i = 0; i < REPS; i++) {
    if (i & 1) { jt.push(...timeFn(jfn, n, 1)); wt.push(...timeFn(wfn, n, 1)); }
    else { wt.push(...timeFn(wfn, n, 1)); jt.push(...timeFn(jfn, n, 1)); }
  }
  const wm = median(wt), jm = median(jt);
  rows.push({ name, n, wasm: wm, v8: jm, ratio: wm / jm, wlo: lo(wt), whi: hi(wt), jlo: lo(jt), jhi: hi(jt), ok });
}

rows.sort((a, b) => b.ratio - a.ratio);

const f = (x, d = 3) => x.toFixed(d);
console.log("\n# compiled-wasm vs V8 (Node) — warm, median of " + REPS + " interleaved reps");
console.log("# ratio = compiled_ms / v8_ms   (>1 = compiled slower)\n");
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
console.log(pad("op", 16) + padL("n", 8) + padL("wasm_ms", 11) + padL("v8_ms", 11) + padL("ratio", 8) + "  ok");
for (const r of rows) {
  console.log(pad(r.name, 16) + padL(r.n, 8) + padL(f(r.wasm), 11) + padL(f(r.v8), 11) + padL(f(r.ratio, 2) + "x", 8) + "  " + (r.ok ? "y" : "MISMATCH"));
}

if (mism.length) {
  console.log("\n# CORRECTNESS MISMATCHES");
  for (const m of mism) console.log(`  ${m.name}(${m.n}): wasm=${m.wasm} v8=${m.v8}`);
} else {
  console.log("\n# all checksums match");
}

// families summary
const fam = (name) => name.startsWith("arr") ? "array" : name.startsWith("str") ? "string"
  : name.startsWith("map") || name.startsWith("set") ? "map/set" : name.startsWith("num") ? "numeric"
  : name.startsWith("obj") ? "object" : name.startsWith("json") ? "json" : name.startsWith("alloc") ? "alloc" : "other";
const byFam = {};
for (const r of rows) (byFam[fam(r.name)] ||= []).push(r.ratio);
console.log("\n# family median ratio");
for (const k of Object.keys(byFam).sort()) {
  const m = median(byFam[k]);
  console.log("  " + pad(k, 9) + f(m, 2) + "x  (" + byFam[k].length + " ops, range " + f(lo(byFam[k]), 2) + "-" + f(hi(byFam[k]), 2) + "x)");
}

// machine-readable
import { writeFileSync } from "node:fs";
writeFileSync("results.json", JSON.stringify({ reps: REPS, warm: WARM, rows, mism }, null, 1));
