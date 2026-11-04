import { encodeEngineMessage, decodeEngineMessage, ENGINE_COMMAND, ENGINE_MAX_PAYLOAD, LANE_NATIVE, LANE_ENGINE } from "./engine.generated.js";

declare function controlSend(bytes: Uint8Array): void;
declare function controlReceive(bytes: Uint8Array): void;

export function command(topic: number, payload: Uint8Array): number {
  if (!Number.isInteger(topic) || topic < 0 || topic > 4294967295 || payload.length > ENGINE_MAX_PAYLOAD) return 1;
  return send(encodeEngineMessage(ENGINE_COMMAND, LANE_NATIVE, LANE_ENGINE, 0, topic, payload));
}

export function send(bytes: Uint8Array): number {
  const message = decodeEngineMessage(bytes);
  if (message === null || message.source !== LANE_NATIVE || message.target !== LANE_ENGINE) return 1;
  controlSend(bytes);
  return 0;
}

export function receive(bytes: Uint8Array): number {
  const message = decodeEngineMessage(bytes);
  if (message === null || message.source !== LANE_ENGINE || message.target !== LANE_NATIVE) return 1;
  controlReceive(bytes);
  return 0;
}
