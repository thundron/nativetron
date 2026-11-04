// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit
export const ENGINE_VERSION = 1;
export const ENGINE_MAX_PAYLOAD = 65536;
export const ENGINE_MAX_RATE = 60;
export const ENGINE_HEADER_BYTES = 16;
export const LANE_NATIVE = 0;
export const LANE_UI = 1;
export const LANE_ENGINE = 2;
export const ENGINE_COMMAND = 1;
export const ENGINE_RESULT = 2;
export const ENGINE_ERROR = 3;
export const ENGINE_EVENT = 4;
export const ENGINE_REPORT = 5;

function validHeader(kind, source, target, requestId, topic) {
  return Number.isInteger(kind) && kind >= 1 && kind <= 5 &&
    Number.isInteger(source) && source >= 0 && source <= 2 &&
    Number.isInteger(target) && target >= 0 && target <= 2 && source !== target &&
    Number.isInteger(requestId) && requestId >= 0 && requestId <= 4294967295 &&
    Number.isInteger(topic) && topic >= 0 && topic <= 4294967295;
}

export function encodeEngineMessage(kind, source, target, requestId, topic, payload) {
  if (!validHeader(kind, source, target, requestId, topic) || payload.length > ENGINE_MAX_PAYLOAD) throw new Error("invalid engine message");
  const version = ENGINE_VERSION, payloadLength = payload.length;
  const bytes = new Uint8Array(ENGINE_HEADER_BYTES + payloadLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, version);
  view.setUint8(1, kind);
  view.setUint8(2, source);
  view.setUint8(3, target);
  view.setUint32(4, requestId, true);
  view.setUint32(8, topic, true);
  view.setUint32(12, payloadLength, true);
  bytes.set(payload, ENGINE_HEADER_BYTES);
  return bytes;
}

export function decodeEngineMessage(bytes) {
  if (bytes.length < ENGINE_HEADER_BYTES || bytes.length > ENGINE_HEADER_BYTES + ENGINE_MAX_PAYLOAD) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  const kind = view.getUint8(1);
  const source = view.getUint8(2);
  const target = view.getUint8(3);
  const requestId = view.getUint32(4, true);
  const topic = view.getUint32(8, true);
  const payloadLength = view.getUint32(12, true);
  if (version !== ENGINE_VERSION || payloadLength !== bytes.length - ENGINE_HEADER_BYTES || !validHeader(kind, source, target, requestId, topic)) return null;
  return { kind, source, target, requestId, topic, payload: bytes.subarray(ENGINE_HEADER_BYTES) };
}
