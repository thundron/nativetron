// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit
import { decodeEngineMessage } from "./engine.generated.js";

export const ENGINE_ENVELOPE_LIMIT = 87404;
export function engineBase64(bytes: Uint8Array): string {
  if (!decodeEngineMessage(bytes)) throw new Error("invalid engine frame");
  return Buffer.from(bytes).toString("base64");
}
export function engineFromBase64(value: string): Uint8Array | null {
  if (value.length > ENGINE_ENVELOPE_LIMIT || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const bytes = new Uint8Array(Buffer.from(value, "base64"));
    if (!decodeEngineMessage(bytes) || engineBase64(bytes) !== value) return null;
    return bytes;
  } catch { return null; }
}
export function engineEnvelope(bytes: Uint8Array): string {
  return JSON.stringify({ ntEngine: 1, frame: engineBase64(bytes) });
}
export function parseEngineEnvelope(text: string): Uint8Array | null {
  if (text.length > ENGINE_ENVELOPE_LIMIT + 64) return null;
  try {
    const input: unknown = JSON.parse(text) as unknown;
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const object = input as Record<string, unknown>;
    if (Object.keys(object).length !== 2 || object["ntEngine"] !== 1 || typeof object["frame"] !== "string") return null;
    return engineFromBase64(object["frame"] as string);
  } catch { return null; }
}
