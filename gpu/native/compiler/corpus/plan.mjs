// Turns a runtime WGSL capture corpus into a replay plan for corpus-runner: every unique shader module, and every
// unique pipeline descriptor exactly as the guest created it (entry points, override constants, explicit bind group
// and pipeline layouts, vertex buffers, targets, blend, primitive and depth-stencil state), each tied to the device
// limits its scenario requested.
//   node plan.mjs CORPUS_DIR OUT.json
// CORPUS_DIR holds manifest.json, wgsl/<file>.wgsl and runtime/<scenario>/capture.json.gz (the capture format of the
// gpu-shaders lane). Nothing is copied: the plan refers to the corpus files by absolute path.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const [corpusArg, outArg] = process.argv.slice(2);
if (!corpusArg || !outArg) {
  console.error("usage: node plan.mjs CORPUS_DIR OUT.json");
  process.exit(2);
}
const corpus = resolve(corpusArg);
const manifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const modules = manifest.modules.map((m) => {
  const path = join(corpus, "wgsl", m.file);
  const code = readFileSync(path, "utf8");
  if (sha256(code) !== m.sha256) throw new Error(`${m.file}: content does not match the manifest sha256`);
  return { sha256: m.sha256, path, labels: m.labels, entryPoints: Object.keys(m.entryPoints) };
});
const known = new Set(modules.map((m) => m.sha256));

const limitSets = new Map(); // canonical JSON -> name
const pipelines = new Map(); // canonical descriptor JSON -> record
const runtime = join(corpus, "runtime");
let creations = 0;
for (const scenario of readdirSync(runtime).sort()) {
  const file = join(runtime, scenario, "capture.json.gz");
  if (!existsSync(file)) continue;
  const capture = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  const moduleSha = capture.modules.map((m) => sha256(m.code));
  const bgls = new Map(capture.bgls.map((b) => [b.id, b.entries]));
  const layouts = new Map(capture.layouts.map((l) => [l.id, l.bindGroupLayouts]));
  const device = capture.devices.at(-1);
  const limitsKey = JSON.stringify(Object.entries(device.requiredLimits ?? {}).sort());
  if (!limitSets.has(limitsKey)) limitSets.set(limitsKey, `limits${limitSets.size}`);
  const limits = limitSets.get(limitsKey);
  const stage = (s) => {
    if (!s) return undefined;
    const sha = moduleSha[Number(String(s.module).slice(1))];
    if (!known.has(sha)) throw new Error(`${scenario}: pipeline module ${s.module} is not in the manifest`);
    const out = { module: sha, entryPoint: s.entryPoint, constants: Object.entries(s.constants ?? {}).sort() };
    if (s.buffers) out.buffers = s.buffers;
    if (s.targets) out.targets = s.targets;
    return out;
  };
  for (const p of capture.pipelines) {
    creations++;
    if (typeof p.layout !== "number" || !layouts.has(p.layout)) throw new Error(`${scenario}: pipeline ${p.label} has no explicit layout`);
    const desc = {
      kind: p.kind.startsWith("render") ? "render" : "compute",
      limits,
      layout: layouts.get(p.layout).map((id) => {
        if (!bgls.has(id)) throw new Error(`${scenario}: unknown bind group layout ${id}`);
        return bgls.get(id);
      }),
      compute: stage(p.compute),
      vertex: stage(p.vertex),
      fragment: stage(p.fragment),
      primitive: p.primitive,
      depthStencil: p.depthStencil,
      multisample: p.multisample,
    };
    const key = JSON.stringify(desc);
    let rec = pipelines.get(key);
    if (!rec) pipelines.set(key, (rec = { ...desc, labels: [], scenarios: [], creations: 0, async: [] }));
    rec.creations++;
    if (!rec.labels.includes(p.label)) rec.labels.push(p.label);
    if (!rec.scenarios.includes(scenario)) rec.scenarios.push(scenario);
    const how = p.kind.endsWith("-async") ? "async" : "sync";
    if (!rec.async.includes(how)) rec.async.push(how);
  }
}
const plan = {
  corpus,
  generated: new Date().toISOString(),
  creations,
  limitSets: Object.fromEntries([...limitSets].map(([k, name]) => [name, Object.fromEntries(JSON.parse(k))])),
  modules,
  pipelines: [...pipelines.values()].map((p, i) => ({ id: i, ...p })),
};
writeFileSync(outArg, JSON.stringify(plan));
console.log(JSON.stringify({ modules: modules.length, creations, pipelines: plan.pipelines.length, limitSets: plan.limitSets }));
