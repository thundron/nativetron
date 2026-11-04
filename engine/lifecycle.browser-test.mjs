import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testBrowser } from "../host/test-browser.mjs";

// Real Chrome WebGPU: restart/recovery never reuses GPU handles, post-transfer failures are precise, shutdown is acknowledged.
const browser = await testBrowser(fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""));
const run = async (name, ...args) => {
  const result = await browser.evaluate(`lifecycle.run(${JSON.stringify(name)}, ...${JSON.stringify(args)})`);
  assert.ok(result?.ok, `${name}: ${result?.error} ${JSON.stringify(browser.diagnostics)}`);
  return result.value;
};
try {
  await browser.navigate("/engine/lifecycle.html");
  for (let i = 0; i < 100 && !(await browser.evaluate("!!window.lifecycle")); i++) await browser.delay(50);
  for (const [forceMain, mode] of [[false, "worker"], [true, "main"]]) {
    const value = await run("restart", forceMain);
    assert.equal(value.mode, mode);
    assert.equal(value.gpu, true);
    assert.deepEqual(value.restarts.map((restart) => [restart.ok, restart.mode, restart.generation]), [[true, mode, 2], [true, mode, 3], [true, mode, 4]], JSON.stringify(value.restarts));
    assert.equal(value.readbacks, 4);
    assert.deepEqual(value.bad, [], "GPU errors after restart (stale handles?)");
    assert.equal(value.closed.graceful, true, JSON.stringify(value.closed));
    assert.deepEqual(value.states, ["ready", "restarting", "ready", "restarting", "ready", "restarting", "ready", "disposing", "disposed"]);
    console.log(`engine lifecycle: Chrome ${mode} restart ×3 with fresh GPU state, colour change and acknowledged shutdown passed`);
  }
  const lost = await run("deviceLost");
  assert.equal(lost.ok, true);
  assert.equal(lost.accepted, true);
  assert.equal(lost.fresh, true);
  assert.equal(lost.lost, 1);
  assert.deepEqual(lost.bad, []);
  assert.deepEqual(lost.states.slice(0, 4), ["ready", "lost", "restarting", "ready"]);
  console.log("engine lifecycle: Chrome device loss → lost state → restart on a new device passed");

  const trapped = await run("afterTransferTrap");
  assert.equal(trapped.error?.code, "start-failed-after-transfer", JSON.stringify(trapped));
  assert.equal(trapped.error.canvasTransferred, true);
  assert.match(trapped.error.message, /fixture trap in worker start/);
  assert.equal(trapped.consumed, true);
  assert.ok(trapped.reports.some((line) => line.startsWith("ENGINE_ERROR")));
  assert.ok(!trapped.reports.some((line) => line.startsWith("ENGINE_MODE")), "after-transfer failure reported readiness");
  const recovered = await run("afterTransferRecover");
  assert.equal(recovered.mode, "main");
  assert.match(recovered.reason, /recovered on a replacement canvas/);
  assert.deepEqual([recovered.replaced, recovered.originalAttached, recovered.freshAttached, recovered.sameId], [true, false, true, true]);
  assert.ok(recovered.reports.includes("ENGINE_CANVAS_REPLACED"));
  assert.deepEqual(recovered.bad, []);
  console.log("engine lifecycle: Chrome after-transfer failure is precise, and owned-canvas recovery renders on main passed");

  const aborted = await run("abortProbe");
  assert.equal(aborted.error?.name, "AbortError");
  assert.equal(aborted.error.canvasTransferred, false);
  assert.equal(aborted.mode, "worker");
  const cycles = await run("cycles");
  assert.deepEqual(cycles.map((cycle) => [cycle.mode, cycle.closed.graceful, cycle.bad.length]), [["worker", true, 0], ["main", true, 0], ["worker", true, 0], ["main", true, 0], ["worker", true, 0]]);
  console.log("engine lifecycle: Chrome probe-phase abort keeps the canvas, repeated mount/dispose cycles passed");
} finally { await browser.close(); }
