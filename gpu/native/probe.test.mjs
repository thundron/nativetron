// Native GPU backend correctness on this machine's real adapter (macOS arm64, wgpu-native Metal backend).
// Builds the facade and probe (static link), then checks capabilities, compute/render proofs with readback,
// lifecycle/event semantics, the CAMetalLayer surface path, and module-vs-pipeline shader diagnostics.
// Correctness only: nothing here is timed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const link = process.env.NTGPU_LINK ?? "static";
const probe = execFileSync(`${here}build.sh`, ["--link", link], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1);

function run(...args) {
  const result = spawnSync(probe, args, { cwd: here, encoding: "utf8" });
  assert.ok(result.status === 0 || result.status === 1, `ntgpu-probe ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return { status: result.status, json: JSON.parse(result.stdout) };
}

// Capabilities: a Metal adapter, default device limits unless the adapter's are requested.
{
  const { status, json } = run("caps");
  assert.equal(status, 0);
  assert.equal(json.implementation, "wgpu-native");
  assert.equal(json.adapter.backend, "metal");
  assert.equal(json.device.limits.maxStorageBuffersPerShaderStage, 8);
  assert.ok(json.adapter.limits.maxStorageBuffersPerShaderStage >= 8);
  const raised = run("caps", "--adapter-limits", "--power", "low").json;
  assert.equal(raised.device.limits.maxBufferSize, raised.adapter.limits.maxBufferSize);
  const f16 = json.adapter.features.includes("shader-f16");
  if (f16) assert.ok(run("caps", "--feature", "shader-f16").json.device.features.includes("shader-f16"));
}

// Proofs: atomicCompareExchangeWeak compute + render, both read back through mapAsync events.
{
  const { status, json } = run("proof");
  assert.equal(status, 0, JSON.stringify(json));
  const [atomics, render] = json.proofs;
  assert.deepEqual([atomics.casCounter, atomics.claimedSlots, atomics.winnerFlags, atomics.badSlots], [4096, 64, 64, 0]);
  assert.equal(render.firstPixel, "64,128,191,255");
}

// Lifecycle: bounded queue + wake, scopes, device loss once, re-request, teardown with an outstanding map.
{
  const { status, json } = run("lifecycle");
  assert.equal(status, 0, JSON.stringify(json.checks.filter((c) => !c.ok)));
}

// Surface: CAMetalLayer (not in a window) configure/acquire/clear/present.
{
  const { status, json } = run("surface");
  assert.equal(status, 0, JSON.stringify(json));
  assert.equal(json.surface.presented, 3);
}

// Shaders: the module stage and the pipeline stage are reported separately.
{
  const shader = (...args) => run("shader", ...args);
  let r = shader("fixtures/atomics-cas.wgsl");
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.files[0].pipelines.map((p) => [p.entry, p.ok]), [["claim", true], ["reset", true]]);

  for (const [file, line, summary] of [["bad-syntax", 6, "expected `;`"], ["bad-type", 5, "automatic conversions"], ["unicode-error", 4, "the type of `x`"]]) {
    r = shader(`fixtures/${file}.wgsl`);
    assert.equal(r.status, 1);
    const { module } = r.json.files[0];
    assert.equal(module.ok, false);
    assert.equal(module.status, "validation");
    assert.equal(module.location.lineNum, line);
    assert.ok(module.summary.startsWith(summary), module.summary);
    assert.deepEqual(r.json.files[0].pipelines, []);
    // Synthesized offsets are UTF-16 and agree with lineNum/linePos.
    const source = readFileSync(`${here}fixtures/${file}.wgsl`, "utf8");
    const { lineNum, linePos, offset, length } = module.location;
    assert.ok(length > 0);
    assert.equal(source.slice(offset, offset + length), source.split("\n")[lineNum - 1].slice(linePos - 1, linePos - 1 + length));
  }

  r = shader("fixtures/workgroup-too-large.wgsl");
  assert.equal(r.status, 1);
  assert.equal(r.json.files[0].module.ok, true);
  assert.equal(r.json.files[0].pipelines[0].ok, false);
  assert.match(r.json.files[0].pipelines[0].message, /workgroup size/);

  assert.equal(shader("fixtures/override-required.wgsl").status, 1);
  assert.equal(shader("fixtures/override-required.wgsl", "--constant", "scale=2").status, 0);

  r = shader("fixtures/render-attributes.wgsl");
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.files[0].moduleOnly.map((e) => e.name), ["vs", "fs"]);
  const render = ["--render", "vs,fs", "--target", "rgba8unorm", "--depth", "depth24plus"];
  assert.equal(shader("fixtures/render-attributes.wgsl", ...render, "--vbuf", "20:0=float32x3@0,1=float32x2@12").status, 0);
  r = shader("fixtures/render-attributes.wgsl", ...render, "--vbuf", "20:0=sint32x3@0,1=float32x2@12");
  assert.equal(r.status, 1);
  assert.equal(r.json.files[0].pipelines[0].stage, "render-pipeline");

  r = shader("fixtures/atomics-cas.wgsl", "--entry", "missing");
  assert.equal(r.status, 1);
  assert.match(r.json.files[0].pipelines[0].message, /Unable to find entry point 'missing'/);
}

// Swift host import: module map, events, CAMetalLayer surface configure.
assert.match(execFileSync(probe.replace(/ntgpu-probe$/, "swift-smoke"), { encoding: "utf8" }), /^swift-smoke: .* metal format \d+\n$/);

console.log(`ntgpu (${link}): caps, CAS compute + render readback, lifecycle, CAMetalLayer surface, shader module/pipeline diagnostics, Swift import`);
