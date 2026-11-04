// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit
import { decodeEngineMessage } from "./engine.generated.mjs";

export const ENGINE_ENVELOPE_LIMIT = 87404;
export function engineBase64(bytes) {
  if (!decodeEngineMessage(bytes)) throw new Error("invalid engine frame");
  let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text);
}
export function engineFromBase64(value) {
  if (value.length > ENGINE_ENVELOPE_LIMIT || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const text = atob(value); const bytes = Uint8Array.from(text, char => char.charCodeAt(0));
    if (!decodeEngineMessage(bytes) || engineBase64(bytes) !== value) return null;
    return bytes;
  } catch { return null; }
}
export function engineEnvelope(bytes) {
  return JSON.stringify({ ntEngine: 1, frame: engineBase64(bytes) });
}
export function parseEngineEnvelope(text) {
  if (text.length > ENGINE_ENVELOPE_LIMIT + 64) return null;
  try {
    const input = JSON.parse(text);
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const object = input;
    if (Object.keys(object).length !== 2 || object["ntEngine"] !== 1 || typeof object["frame"] !== "string") return null;
    return engineFromBase64(object["frame"]);
  } catch { return null; }
}
