// Compiles a captured WGSL corpus through the real WebGPU C API of a wgpu-native build (official or patched):
//   1. the existing ntgpu-probe, linked against that build: every module at the shader-module stage, then every module
//      again with its @compute entry points as pipelines (layout "auto", default override values);
//   2. corpus-runner (same facade, same library): every captured pipeline descriptor replayed exactly (explicit bind
//      group/pipeline layouts, override constants, render state) on a device with the limits the guest requested.
//   node gpu/native/compiler/corpus/corpus.mjs [--wgpu official|patched] [--corpus DIR] [--out DIR]
// Defaults: --wgpu patched, --corpus $NT_SHADER_CORPUS or /tmp/nt-native-gpu-shaders-20261113,
//           --out /tmp/nt-native-gpu-compiler/<variant>. Nothing is written inside the worktree. Correctness only.
// Exit status 0 when every module and pipeline was created.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTools } from "../tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const variant = opt("--wgpu", "patched");
const corpus = opt("--corpus", process.env.NT_SHADER_CORPUS ?? "/tmp/nt-native-gpu-shaders-20261113");
const out = opt("--out", `/tmp/nt-native-gpu-compiler/${variant}`);
mkdirSync(out, { recursive: true });

const { prefix, probe, runner } = buildTools(variant);
const sh = (cmd, argv) => execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const planFile = join(out, "plan.json");
console.error(sh("node", [join(here, "plan.mjs"), corpus, planFile]));
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const files = plan.modules.map((m) => m.path);

function runJson(cmd, argv, file) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`${cmd} exited ${r.status}: ${r.stderr}`);
  writeFileSync(join(out, file), r.stdout);
  return JSON.parse(r.stdout);
}

// 1. Existing probe.
const probeModules = runJson(probe, ["shader", "--module-only", ...files], "probe-modules.json");
const probeAuto = runJson(probe, ["shader", ...files], "probe-auto-layout.json");
const moduleFailures = probeModules.files.filter((f) => !f.module.ok).map((f) => ({ file: f.file, summary: f.module.summary, location: f.module.location }));
const autoPipelines = probeAuto.files.flatMap((f) => f.pipelines.map((p) => ({ file: f.file, ...p })));

// 2. Exact pipeline replay.
const replay = runJson(runner, ["replay", planFile], "replay.json");
const byStage = {};
for (const p of replay.pipelines) {
  const k = `${p.kind}:${p.stage}:${p.ok ? "ok" : p.status}`;
  byStage[k] = (byStage[k] ?? 0) + 1;
}
const summary = {
  variant,
  library: join(prefix, "lib", "libwgpu_native.a"),
  implementation: `${replay.implementation} ${replay.version} (${replay.backend}, ${replay.adapter})`,
  corpus: plan.corpus,
  modules: plan.modules.length,
  probe: {
    moduleStage: { ok: probeModules.files.length - moduleFailures.length, failed: moduleFailures.length },
    computeAutoLayout: { pipelines: autoPipelines.length, ok: autoPipelines.filter((p) => p.ok).length },
    failures: moduleFailures,
    pipelineFailures: autoPipelines.filter((p) => !p.ok).map((p) => ({ file: p.file, entry: p.entry, message: p.message })),
  },
  replay: {
    limitSets: replay.limitSets,
    capturedCreations: plan.creations,
    uniquePipelines: plan.pipelines.length,
    ...replay.summary,
    byStage,
    moduleFailures: replay.modules.filter((m) => !m.ok).map((m) => ({ limits: m.limits, path: m.path, location: m.location })),
    pipelineFailures: replay.pipelines.filter((p) => !p.ok).map(({ id, limits, kind, entries, label, stage, status, message }) =>
      ({ id, limits, kind, entries, label, stage, status, message: message?.split("\n").slice(0, 8).join("\n") })),
  },
};
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1));
const ok = moduleFailures.length === 0 && summary.probe.pipelineFailures.length === 0 &&
  replay.summary.modulesOk === replay.summary.modules && replay.summary.pipelinesOk === replay.summary.pipelines &&
  replay.summary.uncapturedErrors === 0;
console.log(JSON.stringify({ ok, out, ...summary, probe: { ...summary.probe, failures: summary.probe.failures.length },
  replay: { ...summary.replay, moduleFailures: summary.replay.moduleFailures.length, pipelineFailures: summary.replay.pipelineFailures.length } }, null, 1));
process.exit(ok ? 0 : 1);
