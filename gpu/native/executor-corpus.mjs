#!/usr/bin/env node
// Runs a captured WGSL corpus (the gpu-shaders lane's manifest.json + wgsl/) through the native executor, using only
// protocol operations: every module's createShaderModule → SHADER_INFO (compilation info), and every recorded
// pipeline shape (entry point × override-constant set × bind-group layouts × render state) → bind group layouts,
// pipeline layout and createComputePipelineAsyncWith / createRenderPipelineAsyncWith → PIPELINE_READY or ERROR.
//   node gpu/native/executor-corpus.mjs --corpus DIR --driver PATH [--out report.json]
// Exit 0 when every module and pipeline was processed (failures are reported, not fatal), 2 on usage errors.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Driver, connect, C, E, S, h } from "./executor-client.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 ? pairs : [...pairs, [value.replace(/^--/, ""), all[i + 1]]]), []));
if (!args.corpus || !args.driver) { console.error("usage: executor-corpus.mjs --corpus DIR --driver PATH [--out FILE]"); process.exit(2); }
const manifest = JSON.parse(readFileSync(join(args.corpus, "manifest.json"), "utf8"));
const enums = C.GPU_ENUMS;
const index = (table, value, what) => {
  if (value === undefined) return 0;
  const at = enums[table].indexOf(value);
  if (at < 0) throw new Error(`corpus ${what} ${value} has no protocol enum`);
  return at;
};
const stageOf = { vertex: C.SHADER_STAGE_VERTEX, fragment: C.SHADER_STAGE_FRAGMENT, compute: C.SHADER_STAGE_COMPUTE };

function layoutEntries(group) {
  const values = [];
  for (const { b, v, t } of group ?? []) {
    const [kind, a, c] = t.split(":");
    if (kind === "buffer") values.push(b, v, C.BINDING_BUFFER, index("buffer", a, "buffer type"), 0, 0, 0, 0, 0, 0);
    else if (kind === "sampler") values.push(b, v, C.BINDING_SAMPLER, index("sampler", a, "sampler type"), 0, 0, 0, 0, 0, 0);
    else if (kind === "texture") values.push(b, v, C.BINDING_TEXTURE, index("sample", a, "sample type"), 0, 0, index("view", c ?? "2d", "view"), t.endsWith(":ms") ? 1 : 0, 0, 0);
    else if (kind === "storageTexture") values.push(b, v, C.BINDING_STORAGE_TEXTURE, 0, 0, 0, index("view", "2d", "view"), 0, index("format", a, "format"), index("access", c, "access"));
    else throw new Error(`corpus binding type ${t}`);
  }
  return values;
}
function constantRecords(set, stage) {
  return Object.entries(set ?? {}).flatMap(([id, value]) => [stage, Number(id), value]);
}
function renderRecords(state) {
  const layouts = [];
  for (const buffer of state.buffers ?? []) {
    layouts.push(buffer.arrayStride, index("step", buffer.stepMode ?? "vertex", "step"), buffer.attributes.length);
    for (const attribute of buffer.attributes) layouts.push(attribute.shaderLocation, attribute.offset, index("vertexFormat", attribute.format, "vertex format"));
  }
  const targets = [];
  for (const target of state.targets ?? []) {
    if (!target) { targets.push(0, 0, 0, 0, 0, 0, 0, 0, 0); continue; }
    const blend = target.blend;
    const component = (part) => [index("blendOperation", part?.operation, "blend op"), index("blendFactor", part?.srcFactor, "blend factor"), index("blendFactor", part?.dstFactor, "blend factor")];
    targets.push(index("format", target.format, "target format"), target.writeMask ?? 15, blend ? 1 : 0, ...(blend ? [...component(blend.color), ...component(blend.alpha)] : [0, 0, 0, 0, 0, 0]));
  }
  const p = state.primitive;
  const primitive = p ? [index("topology", p.topology, "topology"), index("index", p.stripIndexFormat, "strip index"), index("front", p.frontFace, "front face"), index("cull", p.cullMode ?? "none", "cull"), p.unclippedDepth ? 1 : 0] : [];
  const d = state.depthStencil;
  const face = (f) => [index("compare", f?.compare, "compare"), index("stencilOperation", f?.failOp, "stencil op"), index("stencilOperation", f?.depthFailOp, "stencil op"), index("stencilOperation", f?.passOp, "stencil op")];
  const depth = d ? [index("format", d.format, "depth format"), d.depthWriteEnabled ? 1 : 0, index("compare", d.depthCompare, "compare"), ...face(d.stencilFront), ...face(d.stencilBack), d.stencilReadMask ?? 0xffffffff, d.stencilWriteMask ?? 0xffffffff, d.depthBias ?? 0, d.depthBiasSlopeScale ?? 0, d.depthBiasClamp ?? 0] : [];
  const m = state.multisample;
  const multisample = m ? [m.count ?? 1, m.mask ?? 0xffffffff, m.alphaToCoverageEnabled ? 1 : 0] : [];
  return { layouts, targets, primitive, depth, multisample };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unique = (list) => list.filter((item, i) => list.findIndex((other) => same(other, item)) === i);

const driver = await Driver.start(args.driver);
const limits = [];
for (const [name, [preferred]] of Object.entries(manifest.requestedLimits ?? {})) {
  const id = C.GPU_LIMITS.findIndex((entry) => entry?.name === name);
  if (id > 0) limits.push(id, preferred, C.LIMIT_MODE_PREFERRED);
}
const featureBits = (manifest.requestedFeatures ?? []).reduce((bits, name) => bits | (C.GPU_FEATURES.indexOf(name) >= 0 ? 2 ** C.GPU_FEATURES.indexOf(name) : 0), 0);
const device = await connect(driver, 1, { featureBits, limits });
let slot = 1, request = 10;
const report = { corpus: args.corpus, device: { features: device.features, limits: Object.fromEntries(Object.keys(manifest.requestedLimits ?? {}).map((name) => [name, device.limits[name]])) }, modules: [], pipelines: [], summary: {} };
for (const module of manifest.modules) {
  const code = readFileSync(join(args.corpus, "wgsl", module.file), "utf8");
  const created = [];
  const handle = () => { const value = h(slot++); created.push(value); return value; };
  const shader = handle(), shaderRequest = request++;
  const operations = [["createShaderModule", shader, shaderRequest, code, module.labels[0] ?? module.file]];
  const jobs = [];
  const layoutHandle = (layout) => {
    const groups = layout.map((group) => { const value = handle(); operations.push(["createBindGroupLayout", value, layoutEntries(group), "corpus group"]); return value; });
    const value = handle();
    operations.push(["createPipelineLayout", value, groups, "corpus layout"]);
    return value;
  };
  const entries = Object.values(module.entryPoints);
  for (const entry of entries.filter((e) => e.stage === "compute")) {
    for (const layout of unique(entry.layouts.length ? entry.layouts : [null])) {
      const pipelineLayout = layout ? layoutHandle(layout) : 0;
      for (const constants of unique(entry.constants.length ? entry.constants : [{}])) {
        const id = request++;
        operations.push(["createComputePipelineAsyncWith", handle(), id, pipelineLayout, shader, entry.entryPoint, constantRecords(constants, stageOf.compute), entry.pipelineLabels[0] ?? "compute"]);
        jobs.push({ id, kind: "compute", entry: entry.entryPoint, constants, layoutGroups: layout?.length ?? "auto", labels: entry.pipelineLabels });
      }
    }
  }
  const vertices = entries.filter((e) => e.stage === "vertex"), fragments = entries.filter((e) => e.stage === "fragment");
  for (const vertex of vertices) {
    for (const state of unique(vertex.render)) {
      const fragment = fragments.find((f) => f.render.some((r) => same(r, state)) && f.pipelineLabels.some((label) => vertex.pipelineLabels.includes(label))) ?? null;
      const layoutChoices = unique(fragment ? vertex.layouts.filter((l) => fragment.layouts.some((f) => same(f, l))) : vertex.layouts);
      const records = renderRecords(state);
      for (const layout of layoutChoices.length ? layoutChoices : [null]) {
        const pipelineLayout = layout ? layoutHandle(layout) : 0;
        for (const vertexConstants of unique(vertex.constants.length ? vertex.constants : [{}])) {
          for (const fragmentConstants of unique(fragment?.constants.length ? fragment.constants : [{}])) {
            const id = request++;
            const constants = [...constantRecords(vertexConstants, stageOf.vertex), ...constantRecords(fragment ? fragmentConstants : {}, stageOf.fragment)];
            operations.push(["createRenderPipelineAsyncWith", handle(), id, pipelineLayout, shader, vertex.entryPoint, fragment ? shader : 0, fragment?.entryPoint ?? "", fragment ? records.targets : [], records.primitive, records.depth, records.multisample, records.layouts, constants, vertex.pipelineLabels[0] ?? "render"]);
            jobs.push({ id, kind: "render", entry: vertex.entryPoint, fragment: fragment?.entryPoint ?? null, constants: [vertexConstants, fragmentConstants], layoutGroups: layout?.length ?? "auto", targets: (state.targets ?? []).map((t) => t?.format ?? null), depth: state.depthStencil?.format ?? null, labels: vertex.pipelineLabels });
          }
        }
      }
    }
  }
  const submitted = await driver.submit(operations);
  await driver.wait(60000);
  const info = driver.terminal(shaderRequest)[0];
  const batchErrors = submitted.events.filter((event) => event.type === E.ERROR && !event.requestId).map((event) => event.message);
  report.modules.push({ file: module.file, labels: module.labels, bytes: module.bytes, accepted: submitted.submit === 1, status: info?.status ?? null, messages: info?.messages ?? null, batchErrors });
  for (const job of jobs) {
    const [event] = driver.terminal(job.id);
    report.pipelines.push({ file: module.file, ...job, status: event ? (event.type === E.PIPELINE_READY && event.status === S.OK ? "ok" : event.type === E.ERROR ? "error" : `status ${event.status}`) : "missing", message: event?.message ?? null });
  }
  await driver.submit(created.reverse().map((value) => ["destroy", value]));
  const name = `${module.file} shader ${info?.status === S.OK ? "ok" : "ERROR"}; pipelines ${jobs.filter((job) => report.pipelines.find((p) => p.id === job.id)?.status === "ok").length}/${jobs.length}`;
  console.log(name);
}
const uncaught = driver.events.filter((event) => event.type === E.UNCAUGHT_ERROR).map((event) => event.message);
const lost = driver.events.filter((event) => event.type === E.DEVICE_LOST);
report.summary = {
  modules: report.modules.length,
  modulesOk: report.modules.filter((m) => m.status === S.OK).length,
  moduleErrors: report.modules.filter((m) => m.status !== S.OK).map((m) => ({ file: m.file, message: m.messages?.[0]?.message ?? m.batchErrors[0] ?? null, line: m.messages?.[0]?.lineNum ?? null })),
  pipelines: report.pipelines.length,
  computePipelines: report.pipelines.filter((p) => p.kind === "compute").length,
  renderPipelines: report.pipelines.filter((p) => p.kind === "render").length,
  pipelinesOk: report.pipelines.filter((p) => p.status === "ok").length,
  pipelineFailures: Object.entries(report.pipelines.filter((p) => p.status !== "ok").reduce((groups, p) => { const key = `${p.file} ${p.kind}:${p.entry}${p.fragment ? "/" + p.fragment : ""}`; (groups[key] ??= []).push(p.message); return groups; }, {})).map(([key, messages]) => ({ pipeline: key, count: messages.length, message: (messages[0] ?? "").split("\n").slice(0, 6).join(" | ") })),
  uncaughtErrors: uncaught.length,
  deviceLost: lost.length,
};
await driver.quit();
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify(report.summary, null, 1));
