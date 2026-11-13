// WGSL front-end compatibility of the patched wgpu-native build (compiler/patches) against the official prebuilt
// baseline, through the real C API on this machine's GPU (Metal). Generic fixtures only (fixtures/); the consumer
// corpus is checked by corpus/corpus.mjs. Correctness only: nothing is timed.
//   node gpu/native/compiler/compiler.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTools } from "./tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", name);
const tools = { official: buildTools("official"), patched: buildTools("patched") };

function json(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  assert.ok(r.status === 0 || r.status === 1, `${cmd} ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const probeModule = (variant, name) => json(tools[variant].probe, ["shader", "--module-only", fixture(name)]).files[0].module;
const exec = (variant, name, words, ...constants) => json(tools[variant].runner, ["exec", fixture(name), "main", String(words), ...constants]);

// 1. Missing returns that WGSL §9.7 rejects stay rejected at the shader-module stage, with the same diagnostic
//    (message, summary, line/column) as the official build.
for (const [name, line] of [
  ["missing-return-loop-break.wgsl", 2],
  ["missing-return-while.wgsl", 2],
  ["missing-return-break-if.wgsl", 2],
  ["missing-return-empty-loop.wgsl", 2],
]) {
  const official = probeModule("official", name);
  const patched = probeModule("patched", name);
  assert.equal(patched.ok, false, name);
  assert.equal(patched.status, "validation", name);
  assert.equal(patched.summary, "Function [0] 'f' is invalid", name);
  assert.match(patched.message, /The `return` expression None does not match the declared return type/, name);
  assert.equal(patched.location.lineNum, line, name);
  assert.deepEqual(patched, official, `${name}: diagnostic differs from the official build`);
}

// 2. Functions whose end is unreachable by behavior analysis: rejected by the official build, compiled by the patched
//    one, and they compute the right values on the GPU.
{
  const official = probeModule("official", "behavior-unreachable-end.wgsl");
  assert.equal(official.ok, false);
  assert.equal(official.summary, "Function [0] 'insert' is invalid");
  const r = exec("patched", "behavior-unreachable-end.wgsl", 32);
  assert.equal(r.module.ok, true, JSON.stringify(r.module));
  assert.equal(r.pipeline.ok, true, JSON.stringify(r.pipeline));
  const slots = r.words.slice(0, 16);
  assert.deepEqual([...slots].sort((a, b) => a - b), [...Array(16).keys()], "every key got its own slot");
  for (let li = 0; li < 16; li++) {
    const classify = slots[li] % 2 === 0 ? 2 : 3;
    assert.equal(r.words[16 + li], 1 | (classify << 1) | ((li + 1) << 4), `invocation ${li}`);
  }
  assert.equal(r.uncapturedErrors, 0);
}

// 3. A `let` bound to an override is a runtime value: the official build fails pipeline creation, the patched build
//    creates the pipeline and the runtime semantics hold (guarded access skipped, x / 0 == x).
for (const [value, error, words] of [["1", "InvalidAccessIndex", [99, 20, 1, 10]], ["0", "DivisionByZero", [20, 10, 0, 10]]]) {
  const official = exec("official", "override-let-runtime.wgsl", 4, `0=${value}`);
  assert.equal(official.module.ok, true);
  assert.equal(official.pipeline.ok, false);
  assert.match(official.pipeline.message, new RegExp(`ConstantEvaluatorError\\(${error}\\)`));
  const patched = exec("patched", "override-let-runtime.wgsl", 4, `0=${value}`);
  assert.equal(patched.pipeline.ok, true, JSON.stringify(patched.pipeline));
  assert.deepEqual(patched.words, words, `O=${value}`);
}

// 4. Real override-expressions are still evaluated at pipeline creation, by both builds.
for (const variant of ["official", "patched"]) {
  const bad = exec(variant, "override-expression-oob.wgsl", 4, "0=1");
  assert.equal(bad.module.ok, true, variant);
  assert.equal(bad.pipeline.ok, false, variant);
  assert.match(bad.pipeline.message, /ConstantEvaluatorError\(InvalidAccessIndex\)/, variant);
  const good = exec(variant, "override-expression-oob.wgsl", 4, "0=0");
  assert.deepEqual(good.words, [20, 0, 0, 0], variant);
}

console.log("compiler.test.mjs: ok (official baseline and patched build, Metal)");
