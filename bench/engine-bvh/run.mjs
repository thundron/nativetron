// Binned-SAH build/refit: identical TypeScript under V8 and as scriptc wasm reactors (release and speed postures).
//   node run.mjs            non-recording smoke/correctness mode (default; never writes files, prints no timings; SIZES may be set)
//   NT_BVH_EXCLUSIVE=1 node run.mjs --final
//                           exclusive measurement mode; writes last-run.json with every raw sample
// Options (final mode): SIZES=4096,50000  TRIALS=21  WARMUPS=5  LANES=v8,release,speed  DISTRIBUTIONS=0,1,...
//   NT_BVH_OUTPUT=<path> (default last-run.json)
// No forced collection: the generated glue does not wrap the exported bvh_collect symbol, and a V8-only gc() would be asymmetric.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as js from "./workload.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
for (const arg of args) assert.ok(["--smoke", "--final"].includes(arg), `unknown argument ${arg}`);
const final = args.has("--final");
assert.ok(!(final && args.has("--smoke")), "choose --smoke or --final");
if (final) assert.equal(process.env.NT_BVH_EXCLUSIVE, "1", "--final is the exclusive measurement mode: stop other builds/agents, then set NT_BVH_EXCLUSIVE=1");

assert.equal(process.version, "v24.22.1", "use the official Node 24.22.1 distribution");
assert.equal(process.versions.icu, "78.3", "Homebrew's different ICU build is not this benchmark oracle");

const DISTRIBUTION_NAMES = ["architectural", "uniform-soup", "coincident-centroids", "geometric-clusters", "long-slivers", "far-offset-mm", "planar-duplicates"];
const VARIANT_NAMES = ["float64-original", "float32-renderer"];
const PHASES = ["allocate", "bounds", "build", "refit"];
assert.equal(js.DISTRIBUTIONS, DISTRIBUTION_NAMES.length);
const list = (value, fallback) => (value ?? fallback).split(",").map((item) => item.trim()).filter(Boolean);
const integers = (value, fallback) => list(value, fallback).map(Number).map((n) => { assert.ok(Number.isInteger(n) && n >= 0, `bad integer ${n}`); return n; });
const sizes = integers(process.env.SIZES, final ? "4096,50000" : "1,2,3,17,1000,4096");
const distributions = integers(process.env.DISTRIBUTIONS, DISTRIBUTION_NAMES.map((_, d) => d).join(","));
for (const d of distributions) assert.ok(d < DISTRIBUTION_NAMES.length, `unknown distribution ${d}`);
for (const size of sizes) assert.ok(size >= 1 && size <= 2_000_000, "sizes must be 1..2,000,000 triangles");
const trials = final ? Number(process.env.TRIALS ?? 21) : 2, warmups = final ? Number(process.env.WARMUPS ?? 5) : 1;
assert.ok(Number.isInteger(trials) && trials >= (final ? 5 : 1) && Number.isInteger(warmups) && warmups >= 1);

// ---- provenance: the f64 body is house-planner's file byte-for-byte; the f32 body is exactly the type substitution ----
const HEADER_LINES = 3;
const body = (file) => readFileSync(join(HERE, file), "utf8").split("\n").slice(HEADER_LINES).join("\n");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ORIGINAL_SHA256 = "be032a6c9ac667aaa10ac65a3827ecdc843e8a58e942863300214f97f9cce7a5";
const f64Body = body("algorithm-f64.ts");
assert.equal(sha256(f64Body), ORIGINAL_SHA256, "algorithm-f64.ts body is no longer the recorded house-planner binned.ts");
assert.equal(body("algorithm-f32.ts"), f64Body.replaceAll("Float64Array", "Float32Array"), "algorithm-f32.ts must be the mechanical Float64Array→Float32Array substitution");
const originalPath = resolve(process.env.HOUSE_PLANNER ?? "/Users/thundron/Documents/development/house-planner", "packages/render/src/gi/binned.ts");
const provenance = { originalSha256: ORIGINAL_SHA256, f32IsMechanicalSubstitution: true, liveOriginal: existsSync(originalPath) ? (readFileSync(originalPath, "utf8") === f64Body ? "identical" : "differs") : "unavailable" };
assert.notEqual(provenance.liveOriginal, "differs", `${originalPath} changed since the copy; re-copy or set HOUSE_PLANNER`);

// ---- lanes ----
const sources = ["workload.ts", "algorithm-f64.ts", "algorithm-f32.ts"].map((f) => statSync(join(HERE, f)).mtimeMs);
const LANE_DIRS = { release: ".scriptc", speed: ".scriptc/speed" };
const laneNames = final ? list(process.env.LANES, "v8,release,speed") : ["v8", "release", "speed"];
assert.equal(laneNames[0], "v8", "v8 must be the first (reference) lane");
const lanes = [];
for (const name of laneNames) {
  if (name === "v8") { lanes.push({ name, call: (f, ...a) => js[f](...a) }); continue; }
  assert.ok(name in LANE_DIRS, `unknown lane ${name}`);
  const wasmPath = join(HERE, LANE_DIRS[name], "workload.wasm");
  assert.ok(existsSync(wasmPath), `${wasmPath} missing: run build.sh`);
  assert.ok(statSync(wasmPath).mtimeMs >= Math.max(...sources), `${wasmPath} is older than its sources: run build.sh`);
  const bytes = readFileSync(wasmPath);
  const { instantiateFromBytes } = await import(join(HERE, LANE_DIRS[name], "workload.mjs"));
  const api = await instantiateFromBytes(bytes, {});
  assert.equal(api.__memory() instanceof SharedArrayBuffer, false);
  lanes.push({ name, api, bytes: bytes.length, sha256: sha256(bytes), call: (f, ...a) => api[`bvh_${f}`](...a) });
}
const all = (f, ...a) => lanes.map((lane) => lane.call(f, ...a));
const same = (values, what) => { for (let i = 1; i < values.length; i++) assert.equal(values[i], values[0], `${what}: ${lanes[i].name} ≠ v8`); return values[0]; };

for (const [left, right] of [[1.1, 3.7], [1e-20, 1e20], [-3.14159, 9.123], [16777217, 1]]) same(all("f32Probe", left, right), `f32Probe(${left}, ${right})`);

// ---- independent JS validator for the V8 lane (written separately from workload.validate) ----
function independentCheck(tree, tris, T) {
  const stride = js.TRIANGLE_STRIDE, N = tree.count;
  assert.equal(N, 2 * T - 1, "node count");
  const order = [...tree.order.subarray(0, T)].sort((a, b) => a - b);
  order.forEach((value, index) => assert.equal(value, index, "order is not a permutation of 0..T-1"));
  const visited = new Uint8Array(N), area = (n) => { const x = tree.bmax[n * 3] - tree.bmin[n * 3], y = tree.bmax[n * 3 + 1] - tree.bmin[n * 3 + 1], z = tree.bmax[n * 3 + 2] - tree.bmin[n * 3 + 2]; return x * y + y * z + z * x; };
  let maxDepth = 0, sah = 0;
  const stack = [[0, 0, T, 0]];
  while (stack.length) {
    const [n, lo, hi, depth] = stack.pop();
    assert.ok(n >= 0 && n < N && !visited[n], `node ${n} unreachable or visited twice`);
    visited[n] = 1; maxDepth = Math.max(maxDepth, depth); sah += area(n);
    assert.equal(tree.start[n], lo, "range start"); assert.equal(tree.size[n], hi - lo, "range size");
    const L = tree.left[n], R = tree.right[n];
    if (L < 0) {
      assert.ok(R < 0 && hi - lo === 1, "leaf shape");
      const k = tree.order[lo] * stride;
      for (let a = 0; a < 3; a++) {
        const v = [tris[k + a], tris[k + 3 + a], tris[k + 6 + a]];
        assert.ok(tree.bmin[n * 3 + a] === Math.min(...v) && tree.bmax[n * 3 + a] === Math.max(...v), "leaf box is not the exact triangle box");
      }
      continue;
    }
    assert.ok(L > n && R > n, "children must follow their parent");
    const mid = lo + tree.size[L];
    assert.ok(mid > lo && mid < hi, "children must partition the range");
    for (let a = 0; a < 3; a++) {
      assert.ok(tree.bmin[n * 3 + a] === Math.min(tree.bmin[L * 3 + a], tree.bmin[R * 3 + a]) && tree.bmax[n * 3 + a] === Math.max(tree.bmax[L * 3 + a], tree.bmax[R * 3 + a]), "internal box is not the exact child union");
    }
    stack.push([R, mid, hi, depth + 1], [L, lo, mid, depth + 1]);
  }
  assert.equal(visited.reduce((s, v) => s + v, 0), N, "every node reachable exactly once");
  const root = area(0);
  return { maxDepth, sahRatio: root > 0 ? sah / root : null };
}

// ---- validator self-test: corrupt a V8 tree in place and require both validators to reject it ----
function validatorSelfTest() {
  const d = 0, T = 1000, rejected = [];
  js.prepare(d, T);
  for (const v of [0, 1]) {
    js.bounds(d, v); js.build(d, v);
    const tree = v === 0 ? js.tree64Of(d) : js.tree32Of(d), tris = js.trianglesOf(d);
    const leaf = tree.left.findIndex((value) => value < 0), internal = 0;
    const corruptions = [
      ["leaf order", -8, () => { const i = tree.start[leaf], j = (i + T / 2) % T; const t = tree.order[i]; tree.order[i] = tree.order[j]; tree.order[j] = t; return () => { tree.order[j] = tree.order[i]; tree.order[i] = t; }; }],
      ["duplicate primitive", -7, () => { const i = tree.start[leaf], j = (i + 1) % T, t = tree.order[i]; tree.order[i] = tree.order[j]; return () => { tree.order[i] = t; }; }],
      ["loose internal box", -9, () => { const old = tree.bmin[internal]; tree.bmin[internal] = old - 1; return () => { tree.bmin[internal] = old; }; }],
      ["child before parent", -3, () => { const old = tree.left[internal]; tree.left[internal] = internal; return () => { tree.left[internal] = old; }; }],
      ["range partition", -5, () => { const R = tree.right[internal], old = tree.start[R]; tree.start[R] = old + 1; return () => { tree.start[R] = old; }; }],
      ["stale leaf box", [-9, -8], () => { const o = leaf * 3 + 1, old = tree.bmax[o]; tree.bmax[o] = old + 0.5; return () => { tree.bmax[o] = old; }; }],
    ];
    for (const [name, code, corrupt] of corruptions) {
      const restore = corrupt();
      const result = js.validate(d, v);
      assert.ok([code].flat().includes(result), `validate() missed ${name} (code ${result})`);
      assert.throws(() => independentCheck(tree, tris, T), undefined, `independent validator missed ${name}`);
      restore();
      assert.equal(js.validate(d, v), 1); independentCheck(tree, tris, T);
      rejected.push(`${VARIANT_NAMES[v]}: ${name} → ${result}`);
    }
    js.release(d, v);
  }
  return rejected;
}
const selfTest = validatorSelfTest();

// ---- measurement ----
const timeLanes = (order, f, ...a) => {
  const ms = new Array(lanes.length), results = new Array(lanes.length);
  for (const index of order) {
    const start = performance.now(); results[index] = lanes[index].call(f, ...a); ms[index] = performance.now() - start;
  }
  same(results, f);
  return ms;
};
const loadBefore = loadavg();
const cases = [], comparisons = [];
const started = performance.now();
for (const T of sizes) {
  for (const d of distributions) {
    same(all("prepare", d, T), "prepare");
    const record = VARIANT_NAMES.map((variant, v) => ({ distribution: DISTRIBUTION_NAMES[d], variant, triangles: T, nodes: 2 * T - 1, phases: Object.fromEntries(PHASES.map((p) => [p, { samples: lanes.map(() => []), warmupSamples: lanes.map(() => []) }])), laneOrders: [], deformChanged: [], buildChecksums: null }));
    cases.push(...record);
    for (let trial = -warmups; trial < trials; trial++) {
      const index = trial + warmups, caseIndex = cases.length;
      // Rotate lane order (Latin-square style) by trial and case so every lane leads equally often.
      const order = lanes.map((_, i) => (i + index + caseIndex) % lanes.length);
      const sink = (c, phase, ms) => ms.forEach((value, lane) => (trial < 0 ? c.phases[phase].warmupSamples : c.phases[phase].samples)[lane].push(value));
      same(all("reset", d), "reset");
      const variants = index & 1 ? [1, 0] : [0, 1];
      for (const v of variants) {
        const c = record[v];
        c.laneOrders.push(order.map((i) => lanes[i].name).join(">"));
        all("release", d, v);
        sink(c, "allocate", timeLanes(order, "allocate", d, v));
        all("release", d, v);
        sink(c, "bounds", timeLanes(order, "bounds", d, v));
        sink(c, "build", timeLanes(order, "build", d, v));
        for (const result of all("validate", d, v)) assert.equal(result, 1, `${c.distribution}/${c.variant} T=${T}: validate code ${result} after build`);
        const checksums = { topology: same(all("topologyHash", d, v), "topology") >>> 0, bounds: same(all("boundsHash", d, v), "bounds") >>> 0, input: same(all("inputHash", d, v), "bounds-phase input") >>> 0 };
        if (c.buildChecksums === null) {
          c.buildChecksums = checksums;
          Object.assign(c, independentCheck(v === 0 ? js.tree64Of(d) : js.tree32Of(d), js.trianglesOf(d), T));
        } else assert.deepEqual(checksums, c.buildChecksums, "deterministic build changed between trials");
      }
      const changed = same(all("deform", d, index + 1), "deform");
      assert.ok(changed >= Math.ceil(T / 2), `deform changed only ${changed}/${T} triangles`);
      for (const v of variants) {
        const c = record[v];
        c.deformChanged.push(changed);
        sink(c, "refit", timeLanes(order, "refit", d, v));
        for (const result of all("validate", d, v)) assert.equal(result, 1, `${c.distribution}/${c.variant} T=${T}: validate code ${result} after refit`);
        assert.equal(same(all("topologyHash", d, v), "topology after refit") >>> 0, c.buildChecksums.topology, "refit changed topology");
        const refitted = same(all("boundsHash", d, v), "bounds after refit") >>> 0;
        assert.notEqual(refitted, c.buildChecksums.bounds, "refit did not observe the changed geometry");
        if (trial === trials - 1 || trial === -warmups) independentCheck(v === 0 ? js.tree64Of(d) : js.tree32Of(d), js.trianglesOf(d), T);
      }
      for (const v of [0, 1]) all("release", d, v);
    }
    const [f64, f32] = record;
    comparisons.push({ distribution: DISTRIBUTION_NAMES[d], triangles: T, topologyEqual: f64.buildChecksums.topology === f32.buildChecksums.topology, sahRatioF32OverF64: f64.sahRatio && f32.sahRatio ? f32.sahRatio / f64.sahRatio : null, maxDepth: { f64: f64.maxDepth, f32: f32.maxDepth } });
  }
}
const elapsedS = (performance.now() - started) / 1000;

const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { n, medianMs: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2, p95Ms: sorted[Math.ceil(n * 0.95) - 1], minMs: sorted[0], maxMs: sorted[n - 1] };
};
const ratioSummary = (wasm, v8) => {
  const ratios = wasm.map((value, i) => value / v8[i]).sort((a, b) => a - b), n = ratios.length;
  return { medianWasmOverV8: n % 2 ? ratios[(n - 1) / 2] : (ratios[n / 2 - 1] + ratios[n / 2]) / 2, min: ratios[0], max: ratios[n - 1] };
};

const correctness = {
  provenance,
  validatorSelfTest: selfTest,
  cases: cases.length,
  perTrialGates: ["in-module validate() in every lane after build and after refit (counts, ranges, parent multiplicity, permutation, exact leaf/internal boxes)", "exact IEEE bit hashes of triangles, bounds/centroids, topology/order and node boxes equal across lanes", "build hashes identical in every trial", "refit keeps topology, changes node-box hash, and sees ≥50% changed triangles", "independent JS validator on the V8 tree after the first build and after the first/last refit"],
  f32VersusF64: comparisons,
};

if (!final) {
  console.log(JSON.stringify({ mode: "smoke (non-recording; timings discarded)", lanes: lanes.map(({ name, bytes }) => ({ name, bytes })), sizes, distributions: distributions.map((d) => DISTRIBUTION_NAMES[d]), warmups, trials, elapsedS: Math.round(elapsedS), correctness: { ...correctness, f32VersusF64: comparisons.filter((c) => c.triangles === Math.max(...sizes)) } }, null, 2));
  console.log("smoke ok: no files written");
  process.exit(0);
}

for (const c of cases) {
  for (const phase of PHASES) {
    const p = c.phases[phase];
    p.summary = Object.fromEntries(lanes.map((lane, i) => [lane.name, summarize(p.samples[i])]));
    p.paired = Object.fromEntries(lanes.slice(1).map((lane, i) => [lane.name, ratioSummary(p.samples[i + 1], p.samples[0])]));
    p.samples = Object.fromEntries(lanes.map((lane, i) => [lane.name, p.samples[i]]));
    p.warmupSamples = Object.fromEntries(lanes.map((lane, i) => [lane.name, p.warmupSamples[i]]));
  }
}
const readHead = (dir) => {
  try {
    const head = readFileSync(join(dir, ".git/HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5), loose = join(dir, ".git", ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    return readFileSync(join(dir, ".git/packed-refs"), "utf8").split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] ?? null;
  } catch { return null; }
};
const scriptcRoot = process.env.SCRIPTC ? resolve(dirname(process.env.SCRIPTC), "../../..") : null;
const report = {
  date: new Date().toISOString(), mode: "final (exclusive)", node: process.version, v8: process.versions.v8, icu: process.versions.icu,
  system: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0].model, logicalCpus: cpus().length, totalMemBytes: totalmem(), freeMemBytesAtEnd: freemem(), loadAverageBefore: loadBefore, loadAverageAfter: loadavg() },
  scriptc: scriptcRoot ? { root: scriptcRoot, head: readHead(scriptcRoot) } : null,
  modules: lanes.slice(1).map(({ name, bytes, sha256: digest, api }) => ({ lane: name, bytes, sha256: digest, linearMemoryBytesAtEnd: api.__memory().byteLength, sharedMemory: false })),
  v8HeapAtEnd: process.memoryUsage(),
  method: {
    sizes, distributions: distributions.map((d) => DISTRIBUTION_NAMES[d]), variants: VARIANT_NAMES, bins: 16, triangleStride: js.TRIANGLE_STRIDE, warmups, trials,
    pairedInterleaved: "every timed window runs once per lane back-to-back; lane order rotates by trial and case; variant order alternates by trial; warmups use the same schedule and are retained",
    timedWindows: {
      allocate: "allocation-only probe of the arrays buildBinary allocates (with its fills); not subtractable from build",
      bounds: "triangle AABB/centroid arrays as buildWideBvh computes them, including their allocation",
      build: "buildBinary only, including its own allocations; previous tree released before the window",
      refit: "binary refit of changed geometry (deformed before the window, untimed); no allocation",
    },
    untimed: "generation, reset, deform, release, validation, hashing, instantiation",
    forcedCollection: false,
    elapsedS,
  },
  correctness,
  cases,
};
const output = resolve(process.env.NT_BVH_OUTPUT ?? join(HERE, "last-run.json"));
writeFileSync(output, JSON.stringify(report, null, 1) + "\n");
const table = [];
for (const c of cases) for (const phase of PHASES) {
  const row = { case: `${c.distribution}/${c.variant}/${c.triangles}`, phase };
  for (const lane of lanes) row[`${lane.name} median ms`] = Number(c.phases[phase].summary[lane.name].medianMs.toFixed(3));
  for (const lane of lanes.slice(1)) row[`${lane.name}/v8 paired`] = Number(c.phases[phase].paired[lane.name].medianWasmOverV8.toFixed(2));
  table.push(row);
}
console.table(table);
console.log(`wrote ${output} (${cases.length} cases, ${Math.round(elapsedS)} s)`);
