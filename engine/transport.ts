import { encodeEngineMessage, ENGINE_STATE, ENGINE_BULK, LANE_ENGINE, LANE_UI } from "../ipc/engine.generated.js";

// Add {name:"engineOffer",params:["bytes"],returns:"bool"} to a reactor profile.
// true means accepted/copied, not GPU completion or durable consumer storage.
declare function engineOffer(bytes: Uint8Array): boolean;
export function offerState(topic: number, bytes: Uint8Array): boolean {
  return engineOffer(encodeEngineMessage(ENGINE_STATE, LANE_ENGINE, LANE_UI, 0, topic, bytes));
}
export function offerBulk(topic: number, requestId: number, bytes: Uint8Array): boolean {
  return engineOffer(encodeEngineMessage(ENGINE_BULK, LANE_ENGINE, LANE_UI, requestId, topic, bytes));
}
