// Test-only stand-in for scriptc's generated reactor glue (`instantiateFromBytes(bytes, host)`).
// Behaviour is chosen by the module URL's `mode` query, so each mode is a separate module instance.
import { encodeEngineMessage, ENGINE_RESULT, LANE_ENGINE, LANE_NATIVE, LANE_UI } from "../../ipc/engine.generated.mjs";

const mode = new URL(import.meta.url).searchParams.get("mode") ?? "ok";
const log = (globalThis.__engineFixture ??= { instances: 0, calls: [], hooks: {} });

export async function instantiateFromBytes(bytes, host) {
  if (!(bytes instanceof ArrayBuffer) || !WebAssembly.validate(bytes)) throw new Error("fixture expected wasm bytes");
  if (mode === "trap-init") throw new Error("trap: init");
  if (mode === "slow-init") await log.hooks.gate;
  const id = ++log.instances;
  const memory = new WebAssembly.Memory({ initial: 1 });
  let depth = 0;
  const enter = (name, args) => {
    depth++;
    log.calls.push({ id, name, args, depth });
    if (depth > 1) log.calls.push({ id, name: "REENTERED", depth });
  };
  const leave = (name) => { log.calls.push({ id, name: name + ":exit" }); depth--; };
  const frame = (target, topic, payload) => encodeEngineMessage(ENGINE_RESULT, LANE_ENGINE, target, topic, topic, payload);
  return {
    __memory: () => memory.buffer,
    fx_start() {
      enter("start", []);
      try {
        if (mode === "trap-start") throw new Error("trap: start");
        if (mode === "panic-start") host.panic("fixture panic");
        host.gpuReport(`FIXTURE_STARTED ${id}`);
      } finally { leave("start"); }
      return 0;
    },
    fx_frame(time) { enter("frame", [time]); leave("frame"); return 0; },
    fx_event(type, requestId, handle, status, value, text) { enter("event", [type, requestId, handle, status, value, text]); leave("event"); return 0; },
    fx_message(topic, payload) {
      enter("message", [topic, Array.from(payload)]);
      try {
        if (topic === 1) host.engineSend(frame(LANE_UI, 1, payload));
        else if (topic === 2) host.engineSend(frame(LANE_NATIVE, 2, payload));
        else if (topic === 3) throw new Error("trap: message");
        else if (topic === 4) for (let i = 0; i < payload[0] * 10; i++) host.engineSend(frame(LANE_UI, 4, new Uint8Array([i & 255])));
        else if (topic === 5) host.engineSend(encodeEngineMessage(ENGINE_RESULT, LANE_UI, LANE_NATIVE, 0, 5, new Uint8Array(0)));
        else if (topic === 6) log.hooks.during?.(id);
        else if (topic === 7) host.gpuReport("x".repeat(70000));
        else if (topic === 8) host.panic("message panic");
      } finally { leave("message"); }
      return 0;
    },
  };
}
