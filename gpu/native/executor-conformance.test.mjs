// Native conformance: gpu/conformance.ts compiled to native code by scriptc and run against the native executor
// (ntgpu-executor-conformance), checked with the assertions of gpu/conformance-test.mjs: negotiation, descriptors,
// state rejections, exactly-once completion, cancellation, guest and external device loss, restart.
// Needs SCRIPTC (read-only scriptc CLI) and the pinned wgpu-native cache; outputs stay in the build directory.
//   SCRIPTC=… node --test gpu/native/executor-conformance.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GPU_PROTOCOL_IDENTITY, GPU_PROTOCOL_VERSION, GPU_TERMINAL_EVENTS } from "../gpu-host.generated.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const scriptc = process.env.SCRIPTC ?? join(here, "../../../../scriptc/packages/cli/dist/main.js");
const skip = process.platform !== "darwin" || process.arch !== "arm64" ? "macOS arm64 only" : existsSync(scriptc) ? false : `no scriptc CLI (${scriptc})`;

const E = { CAPABILITIES: 1, PIPELINE_READY: 2, MAP_READY: 3, WORK_DONE: 4, DEVICE_LOST: 5, UNCAUGHT_ERROR: 6, ERROR: 9 };
const S = { OK: 0, ERROR: 1, CANCELLED: 2, LOST: 3 };

test("conformance reactor passes on the native executor", { skip, timeout: 600000 }, () => {
  const sanitize = process.env.NTGPU_EXECUTOR_SANITIZE ? ["--sanitize", process.env.NTGPU_EXECUTOR_SANITIZE] : [];
  const out = execFileSync(join(here, "build-executor.sh"), ["--conformance", ...sanitize], { encoding: "utf8", env: { ...process.env, SCRIPTC: scriptc } }).trim().split("\n").pop();
  const log = join(out, "conformance-native.jsonl");
  const run = spawnSync(join(out, "ntgpu-executor-conformance"), ["--log", log], { encoding: "utf8", timeout: 120000 });
  const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(run.status, 0, `conformance driver exited ${run.status}\n${run.stderr}`);
  // Cumulative state at the end of each phase, as the browser test observes it.
  const phases = [];
  const events = [], reports = [];
  for (const line of lines) {
    if (line.phase !== undefined && line.phase > 0) phases.push({ events: [...events], reports: [...reports] });
    if (line.event) events.push(line.event);
    if (line.report !== undefined) reports.push(line.report);
    assert.equal(line.trap, undefined, `guest trapped: ${line.trap}`);
  }
  const failure = reports.find((line) => line.startsWith("CONF_FAIL") || line.includes("FAILED"));
  assert.equal(failure, undefined, reports.join("\n"));
  const terminals = (list, id) => list.filter((event) => event.requestId === id && GPU_TERMINAL_EVENTS.has(event.type));
  const one = (list, id, type, status) => {
    const found = terminals(list, id);
    assert.equal(found.length, 1, `request ${id} completions ${JSON.stringify(found)}`);
    assert.equal(found[0].type, type, `request ${id} type ${JSON.stringify(found[0])}`);
    if (status !== undefined) assert.equal(found[0].status, status, `request ${id} status ${JSON.stringify(found[0])}`);
    return found[0];
  };
  const errors = (list) => list.filter((event) => event.type === E.ERROR);

  let current = phases[0];
  assert.ok(current.reports.includes("CONF_READY"));
  const refused = one(current.events, 1, E.CAPABILITIES, S.ERROR);
  assert.equal(refused.available, false);
  assert.deepEqual(refused.missingLimits, ["maxBindGroups"]);
  const device = one(current.events, 2, E.CAPABILITIES, S.OK);
  assert.deepEqual(device.protocol, { version: GPU_PROTOCOL_VERSION, identity: GPU_PROTOCOL_IDENTITY });
  assert.equal(device.limits.maxStorageBuffersPerShaderStage, Math.min(10, device.adapterLimits.maxStorageBuffersPerShaderStage));
  assert.ok(device.limits.maxColorAttachments >= 4);
  assert.equal(device.features.includes("timestamp-query"), device.adapterFeatures.includes("timestamp-query"));
  for (const id of [10, 11]) one(current.events, id, 7, S.OK);
  for (const id of [12, 13, 14, 15]) one(current.events, id, E.PIPELINE_READY, S.OK);

  current = phases[1];
  assert.ok(current.reports.some((line) => line.startsWith("CONF_RENDER_OK")));
  for (let id = 30; id <= 34; id++) one(current.events, id, E.MAP_READY, S.OK);
  assert.equal(errors(current.events).length, 0, JSON.stringify(errors(current.events)));

  current = phases[2];
  assert.deepEqual(errors(current.events).map((event) => event.message), ["GPU compute pass has ended", "GPU command buffer was already submitted", "GPU draw without a render pipeline"]);
  for (const id of [40, 41, 42]) one(current.events, id, E.WORK_DONE, S.CANCELLED);
  one(current.events, 43, E.WORK_DONE, S.OK);
  let errorCount = errors(current.events).length;

  current = phases[3];
  one(current.events, 50, E.MAP_READY, S.CANCELLED);
  one(current.events, 51, E.MAP_READY, S.OK);
  one(current.events, 52, E.MAP_READY, S.CANCELLED);
  one(current.events, 53, E.PIPELINE_READY, S.CANCELLED);
  one(current.events, 55, E.MAP_READY, S.OK);
  assert.match(one(current.events, 56, E.ERROR, S.ERROR).message, /in use by a pending request/);
  one(current.events, 54, E.WORK_DONE, S.OK);
  const duplicate = errors(current.events).slice(errorCount).filter((event) => event.requestId === 0);
  assert.deepEqual(duplicate.map((event) => event.duplicateRequestId), [54]);
  errorCount = errors(current.events).length;

  current = phases[4];
  assert.ok(current.reports.some((line) => line.startsWith("CONF_LOST")));
  const lossAt = current.events.findIndex((event) => event.type === E.DEVICE_LOST);
  for (const [id, type] of [[70, E.MAP_READY], [71, E.WORK_DONE], [72, E.PIPELINE_READY]]) {
    const event = one(current.events, id, type, S.LOST);
    assert.ok(current.events.indexOf(event) < lossAt, `request ${id} completed after DEVICE_LOST`);
  }
  assert.equal(current.events[lossAt].reason, "destroyed");

  current = phases[5];
  assert.ok(current.reports.includes("CONF_RESTART_OK"));
  one(current.events, 73, E.CAPABILITIES, S.OK);
  one(current.events, 74, E.MAP_READY, S.OK);
  assert.equal(errors(current.events).length, errorCount, "retiring lost handles produced errors");

  current = { events, reports };
  assert.equal(events.filter((event) => event.type === E.DEVICE_LOST).length, 2);
  for (const id of [80, 81]) {
    const [event] = terminals(events, id);
    assert.equal(terminals(events, id).length, 1);
    assert.ok(event.status === S.LOST || event.type === E.ERROR, `request ${id} ${JSON.stringify(event)}`);
  }
  const ids = new Set(events.filter((event) => event.requestId).map((event) => event.requestId));
  for (const id of ids) assert.equal(terminals(events, id).length, 1, `request ${id} completed more than once`);
  assert.equal(events.filter((event) => event.type === E.UNCAUGHT_ERROR).length, 0, `WebGPU validation errors ${JSON.stringify(events.filter((event) => event.type === E.UNCAUGHT_ERROR))}`);
  const summary = lines.find((line) => line.presents !== undefined);
  assert.equal(summary.pending, 0);
  console.log(`GPU conformance (native executor): ${reports.join(" | ")}`);
});
