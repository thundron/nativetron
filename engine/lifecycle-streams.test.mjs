import test from "node:test";
import assert from "node:assert/strict";
import { startEngine } from "./host.js";
import { encodeEngineMessage, decodeEngineMessage, ENGINE_STATE, ENGINE_BULK, LANE_UI, LANE_ENGINE } from "../ipc/engine.generated.mjs";
import { baseOptions, pageScope, bridgedWorkerClass, fixtureLog, settle, ui } from "./fixtures/harness.mjs";
const state = value => encodeEngineMessage(ENGINE_STATE, LANE_UI, LANE_ENGINE, 0, 9, new Uint8Array([value]));
for (const mode of ["main", "worker"]) {
  test(`${mode}: camera traffic coalesces without exhausting reliable control budget`, async () => {
    const { options } = baseOptions({ scope: pageScope(mode === "worker" ? { Worker: bridgedWorkerClass() } : {}) });
    const lane = await startEngine(options); const id = fixtureLog().instances;
    try {
      assert.equal(lane.mode, mode);
      for (let i = 0; i < 1000; i++) assert.equal(lane.sendLatest(state(i % 256)).ok, true);
      await settle(20);
      const messages = fixtureLog().calls.filter(c => c.id === id && c.name === "message" && c.args[0] === 9);
      assert.equal(messages.length, 1); assert.equal(messages[0].args[1][0], 999 % 256);
      for (let i = 0; i < 60; i++) assert.equal(lane.trySend(ui(9)).ok, true);
      assert.equal(lane.trySend(ui(9)).code, "rate-limited");
      lane.setFrameMode("throughput"); await settle();
      if (mode === "main") assert.equal(lane.reactor.host.frameMode, "throughput");
    } finally { await lane.dispose(); }
  });
  test(`${mode}: outgoing state and bulk use acknowledged leases, with observable backpressure`, async () => {
    const received = [], acks = [];
    const { options } = baseOptions({ scope: pageScope(mode === "worker" ? { Worker: bridgedWorkerClass() } : {}), postUi: bytes => {
      received.push(decodeEngineMessage(bytes));
      if (received.at(-1).kind === ENGINE_BULK) return new Promise(resolve => acks.push(resolve));
    } });
    const lane = await startEngine(options), id = fixtureLog().instances;
    let host; fixtureLog().hooks.during = (current, imports) => { if (current === id) host = imports; };
    try {
      lane.send(ui(6)); await settle(20); assert.ok(host);
      const bulk = encodeEngineMessage(ENGINE_BULK, LANE_ENGINE, LANE_UI, 0, 8, new Uint8Array(200000));
      assert.equal(host.engineOffer(bulk), true); assert.equal(host.engineOffer(bulk), true); assert.equal(host.engineOffer(bulk), false);
      for (let i = 0; i < 1000; i++) assert.equal(host.engineOffer(encodeEngineMessage(ENGINE_STATE, LANE_ENGINE, LANE_UI, 0, 7, new Uint8Array([i % 256]))), true);
      await settle(24);
      assert.equal(received.filter(f => f.kind === ENGINE_BULK).length, 2);
      assert.equal(received.find(f => f.kind === ENGINE_STATE).payload[0], 999 % 256);
      assert.equal(host.engineOffer(bulk), false);
      acks.shift()(); await settle(24); assert.equal(host.engineOffer(bulk), true);
      acks.forEach(fn => fn()); await settle(12);
    } finally { fixtureLog().hooks.during = undefined; await lane.dispose(); acks.forEach(fn => fn()); }
  });
}

for (const mode of ["main", "worker"]) {
  test(`${mode}: a rejected bulk consumer is acknowledged as failure, not silently discarded`, async () => {
    const { options } = baseOptions({ scope: pageScope(mode === "worker" ? { Worker: bridgedWorkerClass() } : {}), postUi: bytes => {
      if (decodeEngineMessage(bytes).kind === ENGINE_BULK) return Promise.reject(new Error("image decoder failed"));
    } });
    const lane = await startEngine(options), id = fixtureLog().instances;
    fixtureLog().hooks.during = (current, host) => {
      if (current === id) host.engineOffer(encodeEngineMessage(ENGINE_BULK, LANE_ENGINE, LANE_UI, 0, 8, new Uint8Array(100)));
    };
    try {
      lane.send(ui(6)); await settle(24); assert.equal(lane.state, "failed");
      assert.match(lane.failure.message, /image decoder failed/);
    } finally { fixtureLog().hooks.during = undefined; await lane.dispose(); }
  });
}
