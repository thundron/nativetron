// Real-GPU conformance: runs gpu/.scriptc/conformance.wasm in Chrome WebGPU on the main thread and in a
// dedicated worker, then checks negotiation, descriptors, state rejections, exactly-once completion,
// cancellation, device loss and restart. Correctness only; it records no timings.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";
import { GPU_PROTOCOL_IDENTITY, GPU_PROTOCOL_VERSION, GPU_TERMINAL_EVENTS } from "./gpu-host.generated.js";

const E = { CAPABILITIES: 1, PIPELINE_READY: 2, MAP_READY: 3, WORK_DONE: 4, DEVICE_LOST: 5, UNCAUGHT_ERROR: 6, ERROR: 9 };
const S = { OK: 0, ERROR: 1, CANCELLED: 2, LOST: 3 };
const lanes = (process.env.NT_GPU_LANES ?? "main,worker").split(",");
const browser = await testBrowser(fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""));
const { evaluate, delay } = browser;

async function run(mode) {
  await browser.navigate(`/gpu/conformance.html${mode === "worker" ? "?worker" : ""}`);
  const state = () => evaluate("window.conformance ? ({ events: conformance.events, reports: conformance.reports }) : null");
  const until = async (label, done) => {
    for (let i = 0; i < 200; i++) {
      const current = await state();
      if (current) {
        const failure = current.reports.find((line) => line.startsWith("CONF_FAIL") || line.includes("FAILED"));
        if (failure) throw new Error(`${mode}: ${failure}\n${current.reports.join("\n")}`);
        if (done(current)) return current;
      }
      await delay(50);
    }
    throw new Error(`${mode}: timed out waiting for ${label}: ${JSON.stringify(await state())}`);
  };
  const terminals = (events, id) => events.filter((event) => event.requestId === id && GPU_TERMINAL_EVENTS.has(event.type));
  const one = (events, id, type, status) => {
    const found = terminals(events, id);
    assert.equal(found.length, 1, `${mode}: request ${id} completions ${JSON.stringify(found)}`);
    assert.equal(found[0].type, type, `${mode}: request ${id} type ${JSON.stringify(found[0])}`);
    if (status !== undefined) assert.equal(found[0].status, status, `${mode}: request ${id} status ${JSON.stringify(found[0])}`);
    return found[0];
  };
  const errors = (events) => events.filter((event) => event.type === E.ERROR);

  let current = await until("pipelines", (value) => value.reports.includes("CONF_READY"));
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

  await evaluate("conformance.step(1)");
  current = await until("render readback", (value) => value.reports.some((line) => line.startsWith("CONF_RENDER_OK")));
  for (let id = 30; id <= 34; id++) one(current.events, id, E.MAP_READY, S.OK);
  assert.equal(errors(current.events).length, 0, `${mode}: ${JSON.stringify(errors(current.events))}`);

  await evaluate("conformance.step(2)");
  current = await until("state rejections", (value) => [40, 41, 42, 43].every((id) => terminals(value.events, id).length));
  assert.deepEqual(errors(current.events).map((event) => event.message), ["GPU compute pass has ended", "GPU command buffer was already submitted", "GPU draw without a render pipeline"]);
  for (const id of [40, 41, 42]) one(current.events, id, E.WORK_DONE, S.CANCELLED);
  one(current.events, 43, E.WORK_DONE, S.OK);
  let errorCount = errors(current.events).length;

  await evaluate("conformance.step(3)");
  current = await until("cancellations", (value) => [50, 51, 52, 53, 54, 55, 56].every((id) => terminals(value.events, id).length));
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

  await evaluate("conformance.step(4)");
  current = await until("guest device destruction", (value) => value.reports.some((line) => line.startsWith("CONF_LOST")));
  const lossAt = current.events.findIndex((event) => event.type === E.DEVICE_LOST);
  for (const [id, type] of [[70, E.MAP_READY], [71, E.WORK_DONE], [72, E.PIPELINE_READY]]) {
    const event = one(current.events, id, type, S.LOST);
    assert.ok(current.events.indexOf(event) < lossAt, `${mode}: request ${id} completed after DEVICE_LOST`);
  }
  assert.equal(current.events[lossAt].reason, "destroyed");

  await evaluate("conformance.step(5)");
  current = await until("restart", (value) => value.reports.includes("CONF_RESTART_OK"));
  one(current.events, 73, E.CAPABILITIES, S.OK);
  one(current.events, 74, E.MAP_READY, S.OK);
  assert.equal(errors(current.events).length, errorCount, `${mode}: retiring lost handles produced errors`);

  await evaluate("conformance.stepThenLose(6)");
  current = await until("external loss", (value) => value.events.filter((event) => event.type === E.DEVICE_LOST).length === 2 && [80, 81].every((id) => terminals(value.events, id).length));
  for (const id of [80, 81]) {
    const [event] = terminals(current.events, id);
    assert.equal(terminals(current.events, id).length, 1);
    assert.ok(event.status === S.LOST || event.type === E.ERROR, `${mode}: request ${id} ${JSON.stringify(event)}`);
  }
  await delay(250);
  current = await state();
  const ids = new Set(current.events.filter((event) => event.requestId).map((event) => event.requestId));
  for (const id of ids) assert.equal(terminals(current.events, id).length, 1, `${mode}: request ${id} completed more than once`);
  assert.equal(current.events.filter((event) => event.type === E.UNCAUGHT_ERROR).length, 0, `${mode}: WebGPU validation errors ${JSON.stringify(current.events.filter((event) => event.type === E.UNCAUGHT_ERROR))}`);
  console.log(`GPU conformance (${mode}): ${current.reports.join(" | ")}`);
}

try {
  for (const mode of lanes) await run(mode);
  console.log(`GPU conformance passed on real WebGPU: ${lanes.join(", ")}`);
} finally { await browser.close(); }
