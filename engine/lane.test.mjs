import assert from "node:assert/strict";
import { test } from "node:test";
import { createGpuHost } from "../gpu/host.js";

test("GPU errors never synchronously reenter an active reactor import", async () => {
  let active = true;
  const events = [];
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = createGpuHost({ canvas: {}, scope: {}, getMemory: () => memory.buffer, onEvent: (event) => { assert.equal(active, false); events.push(event); } });
  const bytes = new Uint8Array(memory.buffer, 0, 1); bytes[0] = 255;
  assert.equal(host.apply(bytes, new Uint8Array(memory.buffer, 8, 0), new Uint8Array(memory.buffer, 8, 0)), false);
  assert.equal(events.length, 0);
  active = false;
  await new Promise((done) => setImmediate(done));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 9);
  host.dispose();
});
