import { parseEngineEnvelope, engineBase64 } from "../ipc/engine-bridge.generated.js";
import { decodeEngineMessage, LANE_NATIVE, LANE_ENGINE, type EngineMessage } from "../ipc/engine.generated.js";

declare function ntEval(js: string): void;

const handlers: ((message: EngineMessage) => void)[] = [];

export function onEngineMessage(handler: (message: EngineMessage) => void): void {
  if (handlers.length >= 32) throw new Error("engine handler limit reached");
  handlers.push(handler);
}

export function dispatchEngineMessage(raw: string): boolean {
  const bytes = parseEngineEnvelope(raw);
  if (bytes === null) return false;
  const message = decodeEngineMessage(bytes);
  if (message === null || message.source !== LANE_ENGINE || message.target !== LANE_NATIVE) return false;
  for (let i = 0; i < handlers.length; i++) {
    const handler = handlers[i]!;
    handler(message);
  }
  return true;
}

export function sendEngineMessage(bytes: Uint8Array): void {
  const message = decodeEngineMessage(bytes);
  if (message === null || message.source !== LANE_NATIVE || message.target !== LANE_ENGINE) throw new Error("invalid native engine route");
  ntEval('window.__nt_engine_receive("' + engineBase64(bytes) + '")');
}
