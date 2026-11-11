import test from "node:test";
import assert from "node:assert/strict";
import { createFrameScheduler } from "./frame-scheduler.js";

test("display scheduling preserves the browser refresh hook", () => {
  let callback, cancelled;
  const scheduler = createFrameScheduler("display", {}, { requestAnimationFrame: fn => { callback = fn; return 7; }, cancelAnimationFrame: id => cancelled = id });
  let time; assert.equal(scheduler.request(value => time = value), 7); callback(123); assert.equal(time, 123);
  scheduler.cancel(7); assert.equal(cancelled, 7); scheduler.dispose();
});
test("throughput yields to tasks, supports cancellation and stops on disposal", async () => {
  const scheduler = createFrameScheduler("throughput"); let count = 0;
  const cancelled = scheduler.request(() => count++); scheduler.cancel(cancelled);
  await new Promise(resolve => scheduler.request(time => { assert.equal(typeof time, "number"); count++; resolve(); }));
  assert.equal(count, 1); scheduler.request(() => count++); scheduler.dispose();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 1);
  assert.throws(() => scheduler.request(() => {}), /disposed/);
});
test("unknown modes are rejected rather than silently changing scheduling", () => assert.throws(() => createFrameScheduler("busy-loop"), /invalid/));
