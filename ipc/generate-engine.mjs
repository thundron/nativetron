import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "engine.json"), "utf8"));
const check = process.argv.includes("--check");
let offset = 0;
const layout = spec.header.map((field) => { const [name, type] = field.split(":"); const size = type === "u8" ? 1 : type === "u32" ? 4 : 0; if (!size) throw new Error("unsupported engine header field"); const result = { name, type, offset }; offset += size; return result; });
const fields = new Set(layout.map((field) => field.name));
for (const required of ["version", "kind", "source", "target", "requestId", "topic", "payloadLength"]) if (!fields.has(required)) throw new Error(`missing ${required}`);
const constants = `export const ENGINE_VERSION = ${spec.version};\nexport const ENGINE_MAX_PAYLOAD = ${spec.maxPayloadBytes};\nexport const ENGINE_MAX_RATE = ${spec.maxMessagesPerSecond};\nexport const ENGINE_HEADER_BYTES = ${offset};\n` + Object.entries(spec.lanes).map(([name, value]) => `export const LANE_${name} = ${value};`).join("\n") + "\n" + Object.entries(spec.kinds).map(([name, value]) => `export const ENGINE_${name} = ${value};`).join("\n") + "\n";
const render = (ts) => {
  const t = (type) => ts ? `: ${type}` : "";
  const setters = layout.map((field) => `  view.set${field.type === "u8" ? "Uint8" : "Uint32"}(${field.offset}, ${field.name}${field.type === "u32" ? ", true" : ""});`).join("\n");
  const getters = layout.map((field) => `  const ${field.name} = view.get${field.type === "u8" ? "Uint8" : "Uint32"}(${field.offset}${field.type === "u32" ? ", true" : ""});`).join("\n");
  return `// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit\n` + constants + (ts ? `
export interface EngineMessage { kind: number; source: number; target: number; requestId: number; topic: number; payload: Uint8Array; }
` : "") + `
function validHeader(kind${t("number")}, source${t("number")}, target${t("number")}, requestId${t("number")}, topic${t("number")})${t("boolean")} {
  return Number.isInteger(kind) && kind >= ${Math.min(...Object.values(spec.kinds))} && kind <= ${Math.max(...Object.values(spec.kinds))} &&
    Number.isInteger(source) && source >= 0 && source <= ${Math.max(...Object.values(spec.lanes))} &&
    Number.isInteger(target) && target >= 0 && target <= ${Math.max(...Object.values(spec.lanes))} && source !== target &&
    Number.isInteger(requestId) && requestId >= 0 && requestId <= 4294967295 &&
    Number.isInteger(topic) && topic >= 0 && topic <= 4294967295;
}

export function encodeEngineMessage(kind${t("number")}, source${t("number")}, target${t("number")}, requestId${t("number")}, topic${t("number")}, payload${t("Uint8Array")})${t("Uint8Array")} {
  if (!validHeader(kind, source, target, requestId, topic) || payload.length > ENGINE_MAX_PAYLOAD) throw new Error("invalid engine message");
  const version = ENGINE_VERSION, payloadLength = payload.length;
  const bytes = new Uint8Array(ENGINE_HEADER_BYTES + payloadLength);
  const view = new DataView(bytes.buffer);
${setters}
  bytes.set(payload, ENGINE_HEADER_BYTES);
  return bytes;
}

export function decodeEngineMessage(bytes${t("Uint8Array")})${t("EngineMessage | null")} {
  if (bytes.length < ENGINE_HEADER_BYTES || bytes.length > ENGINE_HEADER_BYTES + ENGINE_MAX_PAYLOAD) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
${getters}
  if (version !== ENGINE_VERSION || payloadLength !== bytes.length - ENGINE_HEADER_BYTES || !validHeader(kind, source, target, requestId, topic)) return null;
  return { kind, source, target, requestId, topic, payload: bytes.subarray(ENGINE_HEADER_BYTES) };
}
`;
};
const bridge = (ts) => {
  const type = (name) => ts ? `: ${name}` : "";
  return `// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit\n` +
    `import { decodeEngineMessage } from "./engine.generated.${ts ? "js" : "mjs"}";\n` + `
export const ENGINE_ENVELOPE_LIMIT = ${Math.ceil((spec.maxPayloadBytes + offset) / 3) * 4};
export function engineBase64(bytes${type("Uint8Array")})${type("string")} {
  if (!decodeEngineMessage(bytes)) throw new Error("invalid engine frame");
  ${ts ? 'return Buffer.from(bytes).toString("base64");' : 'let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text);'}
}
export function engineFromBase64(value${type("string")})${type("Uint8Array | null")} {
  if (value.length > ENGINE_ENVELOPE_LIMIT || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    ${ts ? 'const bytes = new Uint8Array(Buffer.from(value, "base64"));' : 'const text = atob(value); const bytes = Uint8Array.from(text, char => char.charCodeAt(0));'}
    if (!decodeEngineMessage(bytes) || engineBase64(bytes) !== value) return null;
    return bytes;
  } catch { return null; }
}
export function engineEnvelope(bytes${type("Uint8Array")})${type("string")} {
  return JSON.stringify({ ${spec.envelope.marker}: ${spec.envelope.version}, ${spec.envelope.field}: engineBase64(bytes) });
}
export function parseEngineEnvelope(text${type("string")})${type("Uint8Array | null")} {
  if (text.length > ENGINE_ENVELOPE_LIMIT + 64) return null;
  try {
    ${ts ? 'const input: unknown = JSON.parse(text) as unknown;' : 'const input = JSON.parse(text);'}
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    ${ts ? 'const object = input as Record<string, unknown>;' : 'const object = input;'}
    if (Object.keys(object).length !== 2 || object["${spec.envelope.marker}"] !== ${spec.envelope.version} || typeof object["${spec.envelope.field}"] !== "string") return null;
    return engineFromBase64(object["${spec.envelope.field}"]${ts ? " as string" : ""});
  } catch { return null; }
}
`;
};
const outputs = [
  ["engine-bridge.generated.ts", bridge(true)], ["engine-bridge.generated.mjs", bridge(false)],
  ["engine.generated.ts", render(true)], ["engine.generated.mjs", render(false)],
  ["ENGINE.md", `# Engine IPC\n\nGenerated from \`ipc/engine.json\`. Run \`node ipc/generate-engine.mjs --check\`.\n\nThe low-rate control channel connects native, UI and engine lanes. GPU commands and geometry uploads never use it. Payloads are binary, bounded to ${spec.maxPayloadBytes} bytes; page transports allow at most ${spec.maxMessagesPerSecond} messages per second. A topic identifies an application-owned command, not a framework-defined document format. Request ids are caller-owned; result and error responses echo the id.\n\n| field | offset | type |\n|---|---:|---|\n${layout.map((field) => `| ${field.name} | ${field.offset} | ${field.type} |`).join("\n")}\n\nAll multibyte fields are little-endian. The payload follows the ${offset}-byte header. Unknown versions, kinds, lanes, same-lane delivery, incorrect lengths and oversized payloads fail closed.\n\nLanes: ${Object.entries(spec.lanes).map(([key,value]) => `${key}=${value}`).join(", ")}.\n\nKinds: ${Object.entries(spec.kinds).map(([key,value]) => `${key}=${value}`).join(", ")}.\n\nDesktop and mobile message handlers carry \`{ ${spec.envelope.marker}: ${spec.envelope.version}, ${spec.envelope.field}: base64(frame) }\`. JavaScript evaluated by native contains only the base64 alphabet in a fixed call. In-page UI/engine messages use bytes directly, or a Worker postMessage transfer; neither traverses native.\n\nPublic codec: \`encodeEngineMessage(kind, source, target, requestId, topic, payload): Uint8Array\`; \`decodeEngineMessage(bytes): EngineMessage | null\`.\n`],
];
let stale = 0;
for (const [name, next] of outputs) {
  const path = join(here, name);
  let previous = "";
  try { previous = readFileSync(path, "utf8"); } catch {}
  if (previous === next) continue;
  stale++;
  if (check) console.error(`stale: ${path}`); else writeFileSync(path, next);
}
if (check && stale) process.exit(1);
console.log(`engine IPC: ${check ? "generated files up to date" : `wrote ${stale} files`}`);
