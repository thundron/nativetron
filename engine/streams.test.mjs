import test from "node:test";
import assert from "node:assert/strict";
import { createStreams } from "./streams.js";
import { encodeEngineMessage, decodeEngineMessage, ENGINE_STATE, ENGINE_BULK, ENGINE_EVENT, ENGINE_MAX_BULK, LANE_UI, LANE_ENGINE, LANE_NATIVE } from "../ipc/engine.generated.mjs";
const turn = () => new Promise(resolve => setImmediate(resolve));
const frame = (kind, topic, value = 1, size = 1) => encodeEngineMessage(kind, LANE_UI, LANE_ENGINE, 0, topic, new Uint8Array(size).fill(value));

test("a drag retains only the latest state before transmission and while a lease is outstanding", async () => {
  const deliveries = [], acks = [];
  const streams = createStreams({ deliver: bytes => { deliveries.push(decodeEngineMessage(bytes)); return new Promise(resolve => acks.push(resolve)); } });
  for (let i = 0; i < 1000; i++) assert.equal(streams.offer(frame(ENGINE_STATE, 7, i % 256)), true);
  await turn(); assert.equal(deliveries.length, 1); assert.equal(deliveries[0].payload[0], 999 % 256);
  for (let i = 0; i < 1000; i++) streams.offer(frame(ENGINE_STATE, 7, i % 256));
  await turn(); assert.equal(deliveries.length, 1); assert.equal(streams.stats.statePending, 1);
  acks.shift()(); await turn(); assert.equal(deliveries.length, 2); assert.equal(deliveries[1].payload[0], 999 % 256);
  streams.close(); acks.forEach(fn => fn());
});
test("bulk is copied once at admission, bypasses control size/rate, and has two acknowledged slots", async () => {
  const acks = [], seen = [];
  const streams = createStreams({ deliver: bytes => { seen.push(decodeEngineMessage(bytes)); return new Promise(resolve => acks.push(resolve)); } });
  const bytes = frame(ENGINE_BULK, 2, 17, 1024 * 1024);
  assert.equal(streams.offer(bytes), true); bytes[bytes.length - 1] = 0;
  assert.equal(streams.offer(frame(ENGINE_BULK, 2)), true); assert.equal(streams.offer(frame(ENGINE_BULK, 2)), false);
  await turn(); assert.equal(seen.length, 2); assert.equal(seen[0].payload.at(-1), 17);
  assert.equal(streams.offer(frame(ENGINE_BULK, 2)), false);
  acks.shift()(); await turn(); assert.equal(streams.offer(frame(ENGINE_BULK, 2)), true);
  streams.close(); acks.forEach(fn => fn());
});
test("state has bounded topics and cannot be confused with commands or native bulk", async () => {
  const streams = createStreams({ deliver() {}, maxTopics: 2 });
  assert.equal(streams.offer(frame(ENGINE_STATE, 1)), true); assert.equal(streams.offer(frame(ENGINE_STATE, 2)), true);
  assert.equal(streams.offer(frame(ENGINE_STATE, 3)), false); assert.equal(streams.offer(frame(ENGINE_EVENT, 1)), false);
  assert.throws(() => encodeEngineMessage(ENGINE_STATE, LANE_UI, LANE_ENGINE, 1, 0, new Uint8Array()));
  assert.throws(() => encodeEngineMessage(ENGINE_BULK, LANE_ENGINE, LANE_NATIVE, 0, 0, new Uint8Array()));
  assert.throws(() => frame(ENGINE_BULK, 1, 0, ENGINE_MAX_BULK + 1));
  streams.close(); await turn();
});
test("timeout fails a stalled receiver, and close discards pending generations without delayed delivery", async () => {
  const errors = []; let count = 0;
  const streams = createStreams({ deliver: () => { count++; return new Promise(() => {}); }, timeoutMs: 10, onError: error => errors.push(error) });
  streams.offer(frame(ENGINE_STATE, 1)); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(errors.length, 1); streams.close(); streams.offer(frame(ENGINE_STATE, 2)); await turn(); assert.equal(count, 1);
});
