import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { encodeEngineMessage, decodeEngineMessage, ENGINE_COMMAND, ENGINE_MAX_PAYLOAD, LANE_UI, LANE_ENGINE } from "./engine.generated.mjs";
import { engineEnvelope, parseEngineEnvelope, engineBase64, engineFromBase64 } from "./engine-bridge.generated.mjs";

test("engine IPC generated files do not drift", () => execFileSync(process.execPath, [new URL("./generate-engine.mjs", import.meta.url).pathname, "--check"]));
test("binary engine payload round-trips without native routing", () => {
  const payload = new Uint8Array([0, 255, 128, 13, 10]);
  const bytes = encodeEngineMessage(ENGINE_COMMAND, LANE_UI, LANE_ENGINE, 42, 123, payload);
  assert.deepEqual(decodeEngineMessage(bytes), { kind: ENGINE_COMMAND, source: LANE_UI, target: LANE_ENGINE, requestId: 42, topic: 123, payload });
  assert.deepEqual(parseEngineEnvelope(engineEnvelope(bytes)), bytes);
  assert.deepEqual(engineFromBase64(engineBase64(bytes)), bytes);
});
test("engine messages reject drift, truncation, overflows and malformed envelopes", () => {
  const bytes = encodeEngineMessage(ENGINE_COMMAND, LANE_UI, LANE_ENGINE, 0, 1, new Uint8Array());
  for (const [offset, value] of [[0, 9], [1, 99], [2, 99], [3, 1], [12, 99]]) {
    const changed = bytes.slice(); changed[offset] = value;
    assert.equal(decodeEngineMessage(changed), null);
  }
  assert.equal(decodeEngineMessage(bytes.subarray(0, 15)), null);
  assert.throws(() => encodeEngineMessage(ENGINE_COMMAND, LANE_UI, LANE_ENGINE, 0, 1, new Uint8Array(ENGINE_MAX_PAYLOAD + 1)));
  assert.throws(() => encodeEngineMessage(ENGINE_COMMAND, LANE_UI, LANE_ENGINE, -1, 1, new Uint8Array()));
  for (const envelope of ['null', '[]', '{"ntEngine":1,"frame":"!"}', '{"ntEngine":2,"frame":"AAAA"}', '{"ntEngine":1,"frame":"AAAA","extra":0}']) assert.equal(parseEngineEnvelope(envelope), null);
  assert.equal(engineFromBase64("AAAA=="), null);
});
