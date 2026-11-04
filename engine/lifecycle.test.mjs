import assert from "node:assert/strict";
import { test } from "node:test";
import { createEngine, startEngine, watchViewport, ENGINE_STARTUP_QUEUE_LIMIT, ENGINE_CONTROL_QUEUE_LIMIT } from "./host.js";
import { createOutbound, createRateWindow, prepareReactor, wasmExportNames, ENGINE_OUTBOUND_LIMIT } from "./reactor.js";
import { decodeEngineMessage, ENGINE_MAX_RATE, LANE_NATIVE, LANE_UI } from "../ipc/engine.generated.mjs";
import { baseOptions, bridgedWorkerClass, fakeCanvas, fakeDocument, fixtureLog, fixtureWasm, glue, manualClock, native, pageScope, scriptedWorkerClass, settle, ui, wasmUrl } from "./fixtures/harness.mjs";

const callsOf = (id) => fixtureLog().calls.filter((call) => call.id === id);
const lastInstance = () => fixtureLog().instances;
const messagesOf = (id) => callsOf(id).filter((call) => call.name === "message");

test("preparation validates module, wasm and prefixed exports before any canvas use", async () => {
  const names = wasmExportNames(fixtureWasm());
  assert.deepEqual([...names].sort(), ["fx_event", "fx_frame", "fx_message", "fx_start", "memory"]);
  await prepareReactor({ moduleUrl: glue(), wasmUrl: wasmUrl(), prefix: "fx_" });
  await assert.rejects(prepareReactor({ moduleUrl: glue(), wasmUrl: wasmUrl(), prefix: "ntgpu_" }), { code: "wasm-exports-missing", message: /ntgpu_start/ });
  await assert.rejects(prepareReactor({ moduleUrl: glue(), wasmUrl: wasmUrl(fixtureWasm("fx_", ["start", "frame", "event"])), prefix: "fx_" }), { code: "wasm-exports-missing", message: /fx_message/ });
  await assert.rejects(prepareReactor({ moduleUrl: glue(), wasmUrl: "data:application/wasm;base64,AAAA", prefix: "fx_" }), { code: "wasm-invalid" });
  await assert.rejects(prepareReactor({ moduleUrl: glue(), wasmUrl: "x", prefix: "fx_", fetch: async () => ({ ok: false, status: 404 }) }), { code: "wasm-load-failed", message: /HTTP 404/ });
  await assert.rejects(prepareReactor({ moduleUrl: new URL("../ipc/engine.generated.mjs", import.meta.url).href, wasmUrl: wasmUrl(), prefix: "fx_" }), { code: "module-invalid" });
  await assert.rejects(prepareReactor({ moduleUrl: new URL("./fixtures/missing.mjs", import.meta.url).href, wasmUrl: wasmUrl(), prefix: "fx_" }), { code: "module-load-failed" });
  await assert.rejects(prepareReactor({ moduleUrl: glue(), wasmUrl: wasmUrl(), prefix: "bad-prefix" }), { code: "invalid-options" });
});

test("main fallback routes both directions, validates lanes and keeps the frozen loader shape", async () => {
  const { options, toUi, toNative, reports, lifecycle } = baseOptions();
  const lane = await startEngine(options);
  assert.equal(lane.mode, "main");
  assert.equal(lane.reason, "Worker or OffscreenCanvas unavailable");
  assert.equal(lane.state, "ready");
  assert.equal(typeof lane.send, "function");
  assert.equal(typeof lane.dispose, "function");
  assert.ok(lane.reactor?.api);
  lane.send(ui(1, [7, 8]));
  lane.send(native(2, [9]), LANE_NATIVE);
  assert.throws(() => lane.send(native(1)), /invalid engine message route/);
  assert.throws(() => lane.send(ui(1), LANE_NATIVE), /invalid engine message route/);
  assert.throws(() => lane.send(new Uint8Array(4)), /invalid engine message route/);
  assert.equal(lane.trySend(ui(1), 2).code, "invalid-route");
  await settle();
  assert.equal(toUi.length, 1);
  assert.deepEqual([...decodeEngineMessage(toUi[0]).payload], [7, 8]);
  assert.equal(toNative.filter((bytes) => decodeEngineMessage(bytes).topic === 2).length, 1);
  assert.ok(reports.includes("ENGINE_MODE main (Worker or OffscreenCanvas unavailable)"));
  assert.ok(reports.some((line) => line.startsWith("FIXTURE_STARTED")));
  assert.deepEqual(lifecycle.map((event) => event.state), ["ready"]);
  const closed = await lane.dispose();
  assert.equal(closed.graceful, true);
  assert.equal(lane.state, "disposed");
  assert.throws(() => lane.send(ui(1)), /engine lane disposed/);
  assert.equal(lane.dispose(), lane.dispose());
  assert.deepEqual(options.scope.leaks(), { windowListeners: 0, media: 0, observers: 0, frames: 0 });
});

test("inbound sliding-window rate limit rejects the 61st message and recovers as the window slides", async () => {
  const clock = manualClock();
  const { options } = baseOptions({ clock });
  const lane = await startEngine(options);
  for (let i = 0; i < ENGINE_MAX_RATE; i++) { assert.equal(lane.trySend(ui(9)).ok, true); clock.advance(1); }
  const limited = lane.trySend(ui(9));
  assert.equal(limited.code, "rate-limited");
  assert.throws(() => lane.send(ui(9)), /engine control rate exceeded/);
  clock.advance(1000 - ENGINE_MAX_RATE + 1);
  assert.equal(lane.trySend(ui(9)).ok, true);
  assert.equal(lane.trySend(ui(9)).ok, true);
  await settle();
  assert.equal(messagesOf(lastInstance()).length, ENGINE_MAX_RATE + 2);
  assert.equal(lane.stats.rejected, 2);
  await lane.dispose();
});

test("outbound frames are shaped to the rate limit, bounded, and drops are reported", async () => {
  const clock = manualClock();
  const { options, toUi, reports } = baseOptions({ clock });
  const lane = await startEngine(options);
  clock.advance(1000);
  lane.send(ui(4, [20]));
  await settle();
  assert.equal(toUi.length, ENGINE_MAX_RATE);
  assert.equal(lane.reactor.outbound.pending, ENGINE_OUTBOUND_LIMIT - ENGINE_MAX_RATE);
  assert.equal(lane.reactor.outbound.dropped, 200 - ENGINE_OUTBOUND_LIMIT);
  assert.ok(reports.includes("ENGINE_ROUTE_DROPPED 1 outbound frames (queue full)"), "drop was not reported");
  assert.equal(reports.filter((line) => line.startsWith("ENGINE_ROUTE_DROPPED")).length, 1, "drop reports were not rate-limited");
  clock.advance(999);
  assert.equal(toUi.length, ENGINE_MAX_RATE);
  clock.advance(1);
  assert.equal(toUi.length, ENGINE_OUTBOUND_LIMIT);
  const window = createRateWindow(2, 1000, clock.now);
  assert.equal(window.take(), 0); assert.equal(window.take(), 0); assert.equal(window.take(), 1000);
  const delivered = [];
  const shaper = createOutbound({ deliver: (item) => delivered.push(item), now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, limit: 2, rate: 1 });
  shaper.push(1); shaper.push(2); assert.equal(shaper.push(3), false);
  await settle(); assert.deepEqual(delivered, [1]);
  shaper.close(); assert.equal(clock.pending, 0);
  await lane.dispose();
  assert.equal(clock.pending, 0, "outbound drain timer leaked after dispose");
});

test("oversized reports are truncated to the payload bound instead of failing the instance", async () => {
  const { options, toNative, reports } = baseOptions();
  const lane = await startEngine(options);
  lane.send(ui(7));
  await settle();
  assert.equal(lane.state, "ready");
  const report = toNative.map(decodeEngineMessage).find((frame) => frame.payload.length > 20000);
  assert.ok(report && report.payload.length <= 65536);
  assert.ok(reports.some((line) => line.length < 70000 && line.endsWith("…")));
  await lane.dispose();
});

test("no synchronous reentry: sends from inside reactor callbacks are deferred, including across instances", async () => {
  const log = fixtureLog();
  const a = await startEngine(baseOptions().options);
  const idA = lastInstance();
  const b = await startEngine(baseOptions().options);
  const idB = lastInstance();
  const results = [];
  log.hooks.during = (id) => {
    if (id === idA) { results.push(a.trySend(ui(9)), b.trySend(ui(9))); }
  };
  try {
    a.send(ui(6));
    await settle();
  } finally { log.hooks.during = undefined; }
  assert.ok(results.every((result) => result.ok));
  assert.equal(log.calls.some((call) => call.name === "REENTERED"), false);
  const order = log.calls.filter((call) => (call.id === idA || call.id === idB) && call.name.startsWith("message"));
  const aExit = order.findIndex((call) => call.id === idA && call.name === "message:exit");
  const aSecond = order.findIndex((call, index) => index > aExit && call.id === idA && call.name === "message");
  const bEnter = order.findIndex((call) => call.id === idB && call.name === "message");
  assert.ok(aExit >= 0 && aSecond > aExit && bEnter > aExit, JSON.stringify(order));
  await a.dispose(); await b.dispose();
});

test("engine trap discards the instance; explicit restart creates a fresh instance and GPU host", async () => {
  const { options, reports, lifecycle, toUi } = baseOptions();
  const lane = await startEngine(options);
  const first = lane.reactor, firstId = lastInstance();
  lane.send(ui(3));
  await settle();
  assert.equal(lane.state, "failed");
  assert.equal(lane.failure.code, "engine-failed");
  assert.match(lane.failure.message, /trap: message/);
  assert.ok(reports.some((line) => line.startsWith("ENGINE_FAILED")));
  assert.equal(lane.trySend(ui(1)).code, "failed");
  assert.equal(first.host.apply(new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)), false, "failed instance kept its GPU host");
  const result = await lane.restart({ reason: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "main");
  assert.equal(result.generation, 2);
  assert.notEqual(lane.reactor, first);
  assert.notEqual(lane.reactor.host, first.host);
  assert.notEqual(lane.reactor.host.handles, first.host.handles);
  assert.equal(lastInstance(), firstId + 1);
  lane.send(ui(1, [5]));
  await settle();
  assert.equal(toUi.length, 1);
  assert.equal(messagesOf(firstId).length, 1, "message reached the discarded instance");
  assert.deepEqual(lifecycle.map((event) => event.state), ["ready", "failed", "restarting", "ready"]);
  lane.send(ui(8));
  await settle();
  assert.equal(lane.failure.code, "engine-panic");
  assert.equal((await lane.restart()).ok, true);
  await lane.dispose();
  assert.deepEqual(options.scope.leaks(), { windowListeners: 0, media: 0, observers: 0, frames: 0 });
});

test("invalid outbound route from the engine fails the instance rather than routing it", async () => {
  const { options, toNative } = baseOptions();
  const lane = await startEngine(options);
  const before = toNative.length;
  lane.send(ui(5));
  await settle();
  assert.equal(lane.state, "failed");
  assert.equal(lane.failure.code, "invalid-route");
  assert.equal(toNative.length, before);
  await lane.dispose();
});

test("startup failures in main mode reject precisely and release everything", async () => {
  for (const [mode, code, pattern] of [["trap-start", "start-failed", /trap: start/], ["panic-start", "start-failed", /engine panic: fixture panic/], ["trap-init", "instantiate-failed", /trap: init/]]) {
    const { options, reports } = baseOptions({ moduleUrl: glue(mode) });
    await assert.rejects(startEngine(options), (error) => error.code === code && pattern.test(error.message) && error.canvasTransferred === false);
    await settle();
    assert.ok(reports.some((line) => line.startsWith("ENGINE_ERROR")), mode);
    assert.deepEqual(options.scope.leaks(), { windowListeners: 0, media: 0, observers: 0, frames: 0 }, mode);
  }
  const { options } = baseOptions({ prefix: "ntgpu_" });
  await assert.rejects(startEngine(options), { code: "wasm-exports-missing" });
  assert.equal(options.canvas.contexts, 0, "canvas touched before validation");
});

test("startup cancellation: pre-aborted, during probe and after canvas transfer", async () => {
  const workers = [];
  const pre = baseOptions({ scope: pageScope({ Worker: scriptedWorkerClass({}, workers) }), signal: AbortSignal.abort() });
  await assert.rejects(startEngine(pre.options), { name: "AbortError", code: "aborted", canvasTransferred: false });
  assert.equal(workers.length, 0);

  const probing = new AbortController();
  const during = baseOptions({ scope: pageScope({ Worker: scriptedWorkerClass({ probe: "hang" }, workers) }), signal: probing.signal });
  const lane = createEngine(during.options);
  await settle(2);
  probing.abort();
  await assert.rejects(lane.ready, { name: "AbortError", canvasTransferred: false });
  await lane.dispose();
  assert.equal(workers.at(-1).terminated, true);
  assert.equal(during.options.canvas.transferred, false);
  assert.equal(lane.state, "disposed");

  const starting = new AbortController();
  const after = baseOptions({ scope: pageScope({ Worker: scriptedWorkerClass({ start: "hang" }, workers) }), signal: starting.signal });
  const transferring = createEngine(after.options);
  for (let i = 0; i < 20 && !after.options.canvas.transferred; i++) await settle(1);
  starting.abort();
  await assert.rejects(transferring.ready, { name: "AbortError", canvasTransferred: true });
  const disposed = await transferring.dispose();
  assert.equal(disposed.graceful, true);
  const worker = workers.at(-1);
  assert.deepEqual(worker.received.map((message) => message.type), ["probe", "prepare", "start", "stop"]);
  assert.equal(worker.terminated, true);
});

test("probe and preparation failures fall back to main without transferring the canvas", async () => {
  const clock = manualClock();
  const cases = [
    [{ probe: () => ({ type: "probe", available: false, reason: "worker adapter unavailable" }) }, "worker adapter unavailable"],
    [{ prepare: () => ({ type: "prepared", ok: false, reason: "engine reactor HTTP 404" }) }, "worker preparation failed: engine reactor HTTP 404"],
    [{ probe: (data, worker) => { setImmediate(() => worker.fault("syntax")); } }, "module Worker could not start"],
  ];
  for (const [script, reason] of cases) {
    const workers = [];
    const { options } = baseOptions({ scope: pageScope({ Worker: scriptedWorkerClass(script, workers) }) });
    const lane = await startEngine(options);
    assert.equal(lane.mode, "main");
    assert.equal(lane.reason, reason);
    assert.equal(options.canvas.transferred, false);
    assert.equal(workers[0].terminated, true);
    await lane.dispose();
  }
  const workers = [];
  const { options } = baseOptions({ clock, scope: pageScope({ Worker: scriptedWorkerClass({ probe: "hang" }, workers) }) });
  const lane = createEngine(options);
  await settle(2);
  clock.advance(5000);
  await lane.ready;
  assert.equal(lane.reason, "worker probe timed out");
  assert.equal(workers[0].terminated, true);
  await lane.dispose();
});

test("worker start failure after transfer rejects precisely unless owned-canvas recovery is enabled", async () => {
  const failStart = (data) => ({ type: "error", generation: data.generation, code: "start-failed", message: "engine start failed: trap" });
  const workers = [];
  const plain = baseOptions({ scope: pageScope({ Worker: scriptedWorkerClass({ start: failStart }, workers) }) });
  await assert.rejects(startEngine(plain.options), (error) => error.code === "start-failed-after-transfer" && error.canvasTransferred === true && /trap/.test(error.message));
  await settle();
  assert.ok(plain.reports.some((line) => line === "ENGINE_ERROR engine start failed: trap"));
  assert.equal(plain.reports.some((line) => line.startsWith("ENGINE_MODE")), false, "fake readiness reported");
  assert.equal(workers[0].received.at(-1).type, "stop");
  assert.equal(workers[0].terminated, true);

  const doc = fakeDocument();
  const original = fakeCanvas(doc);
  const recovered = baseOptions({ canvas: original, canvasRecovery: "replace", scope: pageScope({ Worker: scriptedWorkerClass({ start: failStart }, workers) }) });
  const lane = await startEngine(recovered.options);
  assert.equal(lane.mode, "main");
  assert.match(lane.reason, /worker failed after canvas transfer .*recovered on a replacement canvas/);
  assert.notEqual(lane.canvas, original);
  assert.equal(doc.replaced.length, 1);
  assert.equal(lane.canvas.getAttribute("id"), "surface");
  assert.equal(lane.canvas.transferred, false);
  await settle();
  assert.ok(recovered.reports.includes("ENGINE_CANVAS_REPLACED"));
  await lane.dispose();

  const custom = fakeCanvas();
  const viaCallback = baseOptions({ canvasRecovery: () => custom, scope: pageScope({ Worker: scriptedWorkerClass({ start: failStart }, workers) }) });
  const callbackLane = await startEngine(viaCallback.options);
  assert.equal(callbackLane.canvas, custom);
  await callbackLane.dispose();

  const clock = manualClock();
  const hanging = baseOptions({ clock, scope: pageScope({ Worker: scriptedWorkerClass({ start: "hang", stop: "hang" }, workers) }) });
  const timed = createEngine(hanging.options);
  for (let i = 0; i < 20 && !hanging.options.canvas.transferred; i++) await settle(1);
  clock.advance(15000);
  await settle();
  clock.advance(1000);
  await assert.rejects(timed.ready, { code: "start-failed-after-transfer", message: /timed out after canvas transfer/ });
  assert.equal(workers.at(-1).terminated, true);
});

test("bounded startup queue flushes in order after ready; overflow is refused", async () => {
  const { options } = baseOptions();
  const lane = createEngine(options);
  for (let i = 0; i < ENGINE_STARTUP_QUEUE_LIMIT; i++) assert.deepEqual(lane.trySend(ui(9, [i])), { ok: true, queued: true });
  assert.equal(lane.trySend(ui(9)).code, "queue-full");
  assert.throws(() => lane.send(ui(9)), /engine startup queue full/);
  await lane.ready;
  await settle();
  const delivered = messagesOf(lastInstance()).map((call) => call.args[1][0]);
  assert.deepEqual(delivered, [...Array(ENGINE_STARTUP_QUEUE_LIMIT).keys()]);
  await lane.dispose();

  const failing = baseOptions({ moduleUrl: glue("trap-start") });
  const failed = createEngine(failing.options);
  failed.send(ui(9));
  await assert.rejects(failed.ready);
  await settle();
  assert.equal(failed.stats.startupDropped, 1);
  assert.ok(failing.reports.some((line) => line.startsWith("ENGINE_QUEUE_DROPPED 1")));
  await failed.dispose();
});

test("worker control queue is bounded by acknowledged credits", async () => {
  const clock = manualClock();
  const workers = [];
  const { options } = baseOptions({ clock, scope: pageScope({ Worker: scriptedWorkerClass({ message: "hang" }, workers) }) });
  const lane = await startEngine(options);
  assert.equal(lane.mode, "worker");
  for (let i = 0; i < ENGINE_CONTROL_QUEUE_LIMIT; i++) { assert.equal(lane.trySend(ui(9)).ok, true); clock.advance(20); }
  const full = lane.trySend(ui(9));
  assert.equal(full.code, "queue-full");
  assert.equal(full.message, "engine control queue full");
  workers[0].emit({ type: "credit", generation: 0, count: 10 });
  await settle();
  assert.equal(lane.trySend(ui(9)).code, "queue-full", "stale-generation credit accepted");
  workers[0].emit({ type: "credit", generation: lane.generation, count: 10 });
  await settle();
  assert.equal(lane.trySend(ui(9)).ok, true);
  assert.equal(lane.stats.inFlight, ENGINE_CONTROL_QUEUE_LIMIT - 9);
  await lane.dispose();
});

test("real worker.js: ready, routing, credits, resize, restart generations and acknowledged shutdown", async () => {
  const workers = [];
  const scope = pageScope({ Worker: bridgedWorkerClass(workers) });
  const { options, toUi, reports, lifecycle } = baseOptions({ scope });
  const lane = await startEngine(options);
  assert.equal(lane.mode, "worker");
  assert.equal(lane.reactor, undefined);
  assert.equal(options.canvas.transferred, true);
  const firstId = lastInstance();
  lane.send(ui(1, [1, 2, 3]));
  lane.send(native(2, [4]), LANE_NATIVE);
  await settle(20);
  assert.deepEqual([...decodeEngineMessage(toUi.at(-1)).payload], [1, 2, 3]);
  assert.equal(lane.stats.inFlight, 0, "credits were not returned");
  assert.ok(reports.some((line) => line === `FIXTURE_STARTED ${firstId}`));
  const resizes = () => callsOf(lastInstance()).filter((call) => call.name === "event" && call.args[0] === 8);
  assert.deepEqual(resizes().at(-1)?.args.slice(4), [1, JSON.stringify({ width: 320, height: 200 })]);
  scope.devicePixelRatio = 2;
  scope.fireMedia();
  await settle(20);
  assert.deepEqual(resizes().at(-1).args.slice(4), [2, JSON.stringify({ width: 640, height: 400 })]);

  lane.send(ui(3));
  await settle(20);
  assert.equal(lane.state, "failed");
  const restarted = await lane.restart();
  assert.equal(restarted.ok, true);
  assert.equal(restarted.mode, "worker");
  assert.equal(restarted.generation, 2);
  const secondId = lastInstance();
  assert.equal(secondId, firstId + 1);
  await settle(20);
  assert.equal(resizes().length, 1, "new instance did not receive the current size");
  lane.send(ui(1, [9]));
  await settle(20);
  assert.deepEqual([...decodeEngineMessage(toUi.at(-1)).payload], [9]);
  assert.equal(messagesOf(firstId).length, 3);
  assert.equal(workers.length, 1, "restart spawned a second worker");
  assert.deepEqual(scope.leaks(), { windowListeners: 1, media: 1, observers: 1, frames: 0 });

  const closed = await lane.dispose();
  assert.deepEqual(closed, { graceful: true, reason: "", mode: "worker" });
  assert.equal(workers[0].closed, true);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(scope.leaks(), { windowListeners: 0, media: 0, observers: 0, frames: 0 });
  assert.deepEqual(lifecycle.map((event) => event.state), ["ready", "failed", "restarting", "ready", "disposing", "disposed"]);
});

test("real worker.js: start trap after transfer is reported, never fake-ready", async () => {
  const workers = [];
  const { options, reports } = baseOptions({ moduleUrl: glue("trap-start"), scope: pageScope({ Worker: bridgedWorkerClass(workers) }) });
  await assert.rejects(startEngine(options), (error) => error.code === "start-failed-after-transfer" && /trap: start/.test(error.message));
  await settle();
  assert.equal(reports.some((line) => line.startsWith("ENGINE_MODE")), false);
  assert.equal(workers[0].closed, true, "worker did not acknowledge stop");
});

test("shutdown without acknowledgement falls back to terminate within the bound", async () => {
  const clock = manualClock();
  const workers = [];
  const { options, reports } = baseOptions({ clock, scope: pageScope({ Worker: scriptedWorkerClass({ stop: "hang" }, workers) }) });
  const lane = await startEngine(options);
  const closing = lane.dispose();
  await settle();
  assert.equal(workers[0].terminated, false);
  clock.advance(999);
  await settle();
  assert.equal(workers[0].terminated, false);
  clock.advance(1);
  const result = await closing;
  assert.equal(result.graceful, false);
  assert.match(result.reason, /did not acknowledge stop within 1000 ms/);
  assert.equal(workers[0].terminated, true);
  assert.equal(lane.stats.forcedShutdowns, 1);
  await settle();
  assert.ok(reports.some((line) => line.startsWith("ENGINE_SHUTDOWN_FORCED")));
  assert.equal(clock.pending, 0);
});

test("stale-generation worker messages never complete, fail or route for the current generation", async () => {
  const workers = [];
  let release;
  const script = { restart: (data, worker) => { release = () => worker.emit({ type: "ready", generation: data.generation }); return [{ type: "ready", generation: data.generation - 1 }, { type: "failed", generation: data.generation - 1, message: "stale" }, { type: "message", generation: data.generation - 1, bytes: ui(1) }]; } };
  const { options, toUi } = baseOptions({ scope: pageScope({ Worker: scriptedWorkerClass(script, workers) }) });
  const lane = await startEngine(options);
  let done = false;
  const restarting = lane.restart().then((result) => { done = true; return result; });
  assert.equal(lane.restart(), lane.restart(), "concurrent restarts were not coalesced");
  await settle(10);
  assert.equal(done, false, "stale ready completed the restart");
  assert.equal(lane.state, "restarting");
  release();
  const result = await restarting;
  assert.equal(result.ok, true);
  assert.equal(lane.state, "ready");
  workers[0].emit({ type: "message", generation: 1, bytes: new Uint8Array(0) });
  workers[0].emit({ type: "failed", generation: 1, message: "old" });
  await settle();
  assert.equal(lane.state, "ready");
  assert.equal(toUi.length, 0);
  await lane.dispose();
});

test("worker faults, device loss, unresponsive restart and canvas-lost results are explicit", async () => {
  const workers = [];
  const { options, lifecycle } = baseOptions({ scope: pageScope({ Worker: scriptedWorkerClass({}, workers) }) });
  const lane = await startEngine(options);
  workers[0].emit({ type: "gpu-event", generation: lane.generation, event: { type: 5, requestId: 0, handle: 0, status: 1, reason: "unknown", message: "gone" } });
  await settle();
  assert.equal(lane.state, "lost");
  assert.equal(lane.trySend(ui(1)).ok, true, "lost lane must still accept control");
  assert.equal((await lane.restart()).ok, true);
  workers[0].fault("uncaught");
  await settle();
  assert.equal(lane.state, "failed");
  assert.equal(lane.failure.code, "worker-error");
  assert.equal((await lane.restart()).ok, true, "in-worker restart after a fault");
  assert.ok(lifecycle.some((event) => event.state === "lost" && event.code === "device-lost"));

  const clock = manualClock();
  const dying = baseOptions({ clock, scope: pageScope({ Worker: scriptedWorkerClass({ restart: "hang", stop: "hang" }, workers) }) });
  const dead = await startEngine(dying.options);
  const pending = dead.restart();
  await settle();
  clock.advance(15000);
  await settle();
  clock.advance(1000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "restart-timeout");
  assert.equal(result.workerAlive, false);
  assert.equal(result.canvasTransferred, true);
  assert.equal(workers.at(-1).terminated, true);
  const lost = await dead.restart();
  assert.equal(lost.code, "canvas-lost");
  await dead.dispose();
  assert.equal((await dead.restart()).code, "disposed");
  await lane.dispose();

  const doc = fakeDocument();
  const recovering = baseOptions({ canvas: fakeCanvas(doc), canvasRecovery: "replace", clock, scope: pageScope({ Worker: scriptedWorkerClass({ restart: "hang", stop: "hang" }, workers) }) });
  const recover = await startEngine(recovering.options);
  const first = workers.at(-1);
  const again = recover.restart();
  await settle();
  clock.advance(15000);
  await settle();
  clock.advance(1000);
  for (let i = 0; i < 20 && recover.state !== "ready"; i++) await settle(1);
  const recovered = await again;
  assert.equal(recovered.ok, true, `${recovered.code}: ${recovered.message}`);
  assert.equal(recovered.mode, "worker");
  assert.equal(first.terminated, true);
  assert.notEqual(workers.at(-1), first);
  assert.equal(doc.replaced.length, 1);
  assert.equal(recover.canvas.transferred, true);
  const closing = recover.dispose();
  await settle();
  clock.advance(1000);
  assert.equal((await closing).graceful, false);
  assert.equal(clock.pending, 0);
});

test("restart is refused while starting and dispose during startup cancels cleanly", async () => {
  const workers = [];
  const { options } = baseOptions({ scope: pageScope({ Worker: scriptedWorkerClass({ probe: "hang" }, workers) }) });
  const lane = createEngine(options);
  assert.equal((await lane.restart()).code, "starting");
  const closed = lane.dispose();
  await assert.rejects(lane.ready, { name: "AbortError" });
  assert.equal((await closed).graceful, true);
  assert.deepEqual(workers[0].received.map((message) => message.type), ["probe", "stop"]);
  assert.equal(workers[0].terminated, true);
  assert.equal(lane.state, "disposed");
});

test("viewport watcher stays single-armed across DPR changes and leaves nothing behind", () => {
  const scope = pageScope();
  const canvas = fakeCanvas();
  const sizes = [];
  const watcher = watchViewport(scope, canvas, (...size) => sizes.push(size));
  watcher.refresh();
  for (let i = 0; i < 5; i++) { scope.devicePixelRatio = 1 + i; scope.fireMedia(); assert.deepEqual(scope.leaks().media, 1); }
  scope.dispatch("resize"); scope.dispatch("resize");
  assert.equal(scope.leaks().frames, 1, "window resize was not coalesced");
  scope.runFrames();
  canvas.clientWidth = 100; scope.resizeObservers();
  scope.dispatch("resize");
  watcher.dispose();
  assert.deepEqual(scope.leaks(), { windowListeners: 0, media: 0, observers: 0, frames: 0 });
  const count = sizes.length;
  scope.fireMedia(); scope.runFrames(); scope.resizeObservers();
  assert.equal(sizes.length, count);
  assert.deepEqual(sizes[0], [320, 200, 1]);
  assert.deepEqual(sizes.at(-1), [500, 1000, 5]);
});

test("repeated mount/restart/dispose cycles leak no listeners, workers or timers", async () => {
  const clock = manualClock();
  const workers = [];
  const scope = pageScope({ Worker: bridgedWorkerClass(workers) });
  for (let i = 0; i < 6; i++) {
    const { options } = baseOptions({ scope, clock, forceMain: i % 2 === 1 });
    const lane = await startEngine(options);
    assert.equal(lane.mode, i % 2 ? "main" : "worker");
    for (let r = 0; r < 3; r++) assert.equal((await lane.restart()).ok, true);
    assert.equal(lane.generation, 4);
    lane.send(ui(1, [i]));
    await settle(10);
    assert.equal((await lane.dispose()).graceful, true);
    assert.deepEqual(scope.leaks(), { windowListeners: 0, media: 0, observers: 0, frames: 0 }, `cycle ${i}`);
  }
  assert.equal(workers.length, 3);
  assert.ok(workers.every((worker) => worker.terminated && worker.closed));
  assert.equal(clock.pending, 0);
});

test("dispose during an in-flight instantiation disposes the orphan before it can start", async () => {
  const log = fixtureLog();
  let release;
  log.hooks.gate = new Promise((done) => { release = done; });
  const { options } = baseOptions({ moduleUrl: glue("slow-init") });
  const lane = createEngine(options);
  for (let i = 0; i < 50 && options.scope.leaks().observers === 0; i++) await settle(1);
  assert.equal(options.scope.leaks().observers, 1, "instantiation never began");
  const before = lastInstance();
  const closing = lane.dispose();
  await assert.rejects(lane.ready, { name: "AbortError" });
  release();
  await settle();
  log.hooks.gate = undefined;
  assert.equal((await closing).graceful, true);
  assert.equal(lastInstance(), before + 1, "orphan instance was never created");
  assert.equal(callsOf(before + 1).some((call) => call.name === "start"), false, "orphan instance was started");
  assert.deepEqual(options.scope.leaks(), { windowListeners: 0, media: 0, observers: 0, frames: 0 });
});

test("dispose during a worker restart resolves the restart as aborted and still stops gracefully", async () => {
  const workers = [];
  const { options } = baseOptions({ scope: pageScope({ Worker: scriptedWorkerClass({ restart: "hang" }, workers) }) });
  const lane = await startEngine(options);
  const restarting = lane.restart();
  await settle();
  const closed = await lane.dispose();
  assert.deepEqual(await restarting, { ok: false, code: "aborted", message: "engine lane disposed during restart", mode: "worker", generation: 2 });
  assert.equal(closed.graceful, true);
  assert.equal(lane.state, "disposed");
  assert.equal(workers[0].terminated, true);
});

test("consumer callback exceptions are reported and never propagate into the engine", async () => {
  const { options, reports } = baseOptions();
  options.postUi = () => { throw new Error("ui consumer broke"); };
  options.onEvent = () => { throw new Error("event consumer broke"); };
  const lane = await startEngine(options);
  lane.send(ui(1, [1]));
  lane.send(ui(1, [2]));
  await settle();
  assert.equal(lane.state, "ready");
  assert.equal(messagesOf(lastInstance()).length, 2);
  assert.equal(reports.filter((line) => line === "ENGINE_CALLBACK_ERROR ui consumer broke").length, 1, "callback errors were not reported once per second");
  await lane.dispose();
});
