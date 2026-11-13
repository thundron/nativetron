// TEST-ONLY Worker for `Nativetron --native-gpu-selftest=wire` (served from /__ntgpu/ only in that mode).
// Drives the production transport core (engine/native-gpu.js) and wire (engine/native-gpu-wire.js) from a
// Worker against the real WKURLSchemeHandler bridge and the recording executor (native-gpu-recorder.c), which
// hashes what it consumed and echoes upload bytes as MAP_READY readbacks. Proves byte-exact crossing in both
// directions, ordering, device-epoch handling, native ticks and generation retirement. It executes no GPU work.
import { createNativeGpuHost } from "/engine/native-gpu.js";
import { createNativeGpuWire, WIRE_CHUNK_RESERVE } from "/engine/native-gpu-wire.js";

const fnv = (bytes) => { let h = 2166136261; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const MiB = 1048576;
const memory = new WebAssembly.Memory({ initial: 768 }); // 48 MiB, like a reactor's linear memory
const heap = () => new Uint8Array(memory.buffer);
const fill = (at, length, seed) => { const view = heap().subarray(at, at + length); for (let i = 0; i < length; i++) view[i] = (i * 31 + seed + (i >>> 13)) & 255; return view; };
const tag = (at, text) => { for (let i = 0; i < 4; i++) heap()[at + i] = text.charCodeAt(i); };

function engine(gen, native, checks) {
  const events = [], frames = [], waiters = [];
  let failure = null;
  const notify = () => { for (const w of [...waiters]) if (w.test()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };
  const until = (label, test, ms = 20000) => new Promise((resolve, reject) => {
    if (test()) { resolve(); return; }
    const w = { test, resolve }; waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`gen ${gen}: timed out waiting for ${label}; failure=${failure?.message}; events=${events.map((e) => `${e.type}:${e.requestId}:${e.status}`).join(",")}; wire=${JSON.stringify(wire.stats)}; queue=${JSON.stringify(host.queue)} device=${host.deviceGeneration}`)); } }, ms);
  });
  const wire = createNativeGpuWire({ endpoint: native.endpoint, session: native.session, engine: gen });
  let host;
  host = createNativeGpuHost({
    transport: wire.connect({ receive: (m) => host?.receive(m), resume: () => host?.resume(), fail: (e) => { failure = e; notify(); } }),
    getMemory: () => memory.buffer, engineGeneration: gen, chunkHeaderBytes: WIRE_CHUNK_RESERVE,
    createScheduler: (mode) => wire.createScheduler(mode),
    onEvent: (event) => { events.push(event); notify(); },
    onFrame: (time) => { frames.push(time); notify(); },
    onFailure: (error) => { failure = error; notify(); },
  });
  const submit = (commandAt, commandBytes, uploadAt, uploadBytes) => {
    const batch = new Uint8Array(memory.buffer, commandAt, commandBytes), uploads = new Uint8Array(memory.buffer, uploadAt, uploadBytes);
    const expect = { commandHash: fnv(batch), uploadHash: fnv(uploads), commandBytes, uploadBytes, echo: uploads.slice(0, Math.min(uploadBytes, 6 * MiB)) };
    const ok = host.apply(batch, uploads, new Uint8Array(memory.buffer, 40 * MiB, 4096));
    if (!ok) throw new Error(`gen ${gen}: apply refused`);
    return { sequence: host.stats.batches, ...expect };
  };
  const workDone = (n) => events.find((e) => e.type === 4 && e.requestId === n);
  const verify = (name, entry) => {
    const done = workDone(entry.sequence);
    checks.push({ name: `${name}: executor consumed byte-exact commands`, ok: done?.commandHash === entry.commandHash && done?.commandBytes === entry.commandBytes });
    checks.push({ name: `${name}: executor consumed byte-exact uploads`, ok: done?.uploadHash === entry.uploadHash && done?.uploadBytes === entry.uploadBytes });
  };
  return { host, wire, events, frames, until, submit, workDone, verify, get failure() { return failure; } };
}

async function run(native) {
  const checks = [], timings = {};
  // Generation 1.
  const one = engine(1, native, checks);
  fill(0, 4096, 1); tag(0, "SMAL");
  const small = one.submit(0, 64, 0, 0);
  await one.until("small WORK_DONE", () => one.workDone(small.sequence) || one.failure);
  one.verify("64-byte batch", small);

  // 200 KiB commands + 9 MiB + 3 uploads: 1 command chunk + 3 upload chunks (two reassembled natively);
  // the recorder echoes the first 6 MiB back, which returns as two bounded readback chunks.
  fill(1 * MiB, 200 * 1024, 7); tag(1 * MiB, "BIGR");
  fill(8 * MiB, 9 * MiB + 3, 11);
  const started = performance.now();
  const big = one.submit(1 * MiB, 200 * 1024, 8 * MiB, 9 * MiB + 3);
  fill(8 * MiB, 9 * MiB + 3, 99); // the guest may overwrite its arenas as soon as apply returns
  await one.until("big MAP_READY", () => one.events.some((e) => e.type === 3 && e.requestId === 100000 + big.sequence) || one.failure);
  timings.bigSubmissionToReadbackMs = performance.now() - started;
  one.verify("9 MiB upload batch", big);
  const map = one.events.find((e) => e.type === 3 && e.requestId === 100000 + big.sequence);
  checks.push({ name: "6 MiB readback returned byte-exact through two chunks", ok: map?.status === 0 && map.data?.length === big.echo.length && fnv(map.data) === fnv(big.echo) });

  // Frame request decoded natively -> frame-request -> host scheduler -> native tick -> onFrame.
  tag(0, "FRAM");
  const framed = one.submit(0, 64, 0, 0);
  await one.until("native tick", () => one.frames.length > 0 || one.failure);
  checks.push({ name: "executor frame request produced a native tick and a frame callback", ok: one.frames.length === 1 && one.workDone(framed.sequence) !== undefined });

  // Device loss: the epoch advances; later traffic carries the new epoch and is accepted.
  tag(0, "LOST");
  one.submit(0, 64, 0, 0);
  await one.until("DEVICE_LOST", () => one.events.some((e) => e.type === 5) || one.failure);
  tag(0, "SMAL");
  const after = one.submit(0, 128, 0, 0);
  await one.until("post-loss WORK_DONE", () => one.workDone(after.sequence) || one.failure);
  checks.push({ name: "device epoch advanced after DEVICE_LOST and later events were accepted", ok: one.host.deviceGeneration === 1 && one.workDone(after.sequence) !== undefined });
  await one.until("all acknowledged", () => one.host.queue.submissions === 0 || one.failure);
  checks.push({ name: "every submission acknowledged after consumption", ok: one.host.queue.ackedThrough === one.host.stats.batches && !one.failure });
  checks.push({ name: "command/upload chunks went out without a transport copy", ok: one.wire.stats.copiedChunks === 0 && one.wire.stats.zeroCopyChunks >= 4 });
  const firstStats = { core: { ...one.host.stats }, wire: { ...one.wire.stats } };
  one.host.dispose();

  // Generation 2 retires generation 1 for good.
  const two = engine(2, native, checks);
  tag(0, "SMAL");
  const fresh = two.submit(0, 96, 0, 0);
  await two.until("gen 2 WORK_DONE", () => two.workDone(fresh.sequence) || two.failure);
  two.verify("generation 2 batch", fresh);
  const stale = await fetch(`${native.endpoint}poll?engine=1`, { headers: { "X-NT-GPU-Session": native.session } });
  checks.push({ name: "retired generation 1 is refused (410)", ok: stale.status === 410 });
  const forged = await fetch(`${native.endpoint}poll?engine=2`, { headers: { "X-NT-GPU-Session": "0".repeat(64) } });
  checks.push({ name: "wrong capability is refused (401)", ok: forged.status === 401 });
  const secondStats = { core: { ...two.host.stats }, wire: { ...two.wire.stats } };
  two.host.dispose();
  return { checks, timings, stats: [firstStats, secondStats], failure: one.failure?.message ?? two.failure?.message ?? null };
}

self.onmessage = async ({ data }) => {
  try { self.postMessage({ ok: true, result: await run(data) }); }
  catch (error) { self.postMessage({ ok: false, error: `${error} @ ${error?.stack ?? ""}` }); }
};
