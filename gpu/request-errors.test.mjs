import { test } from "node:test";
import assert from "node:assert/strict";
import { createGpuHost } from "./host.js";
import { GPU_FIXED_LAYOUTS, GPU_PROTOCOL_HEADER_BYTES, writeGpuProtocolHeader } from "./gpu-host.generated.js";

test("an async operation rejected during decode preserves its request id", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 }), events = [];
  const layout = GPU_FIXED_LAYOUTS.mapAsync;
  const bytes = new Uint8Array(memory.buffer, 0, GPU_PROTOCOL_HEADER_BYTES + layout.bytes);
  const base = writeGpuProtocolHeader(bytes);
  const view = new DataView(memory.buffer, base);
  bytes[base] = layout.code;
  view.setUint32(layout.fields.requestId, 55, true);
  view.setUint32(layout.fields.buffer, 1048577, true);
  view.setUint32(layout.fields.mode, 1, true);
  view.setFloat64(layout.fields.size, 4, true);
  view.setUint32(layout.fields.destination + 4, 4, true);
  const host = createGpuHost({ canvas: {}, scope: {}, getMemory: () => memory.buffer, onEvent: (event) => events.push(event) });
  assert.equal(host.apply(bytes, new Uint8Array(memory.buffer, 100, 0), new Uint8Array(memory.buffer, 100, 4)), false);
  await new Promise((done) => setImmediate(done));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 9);
  assert.equal(events[0].requestId, 55);
  assert.equal(events[0].handle, 1048577);
  assert.notEqual(events[0].fatal, true);
  host.dispose();
});
