import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
const at = (name) => layout.find((field) => field.name === name).offset;
const swift = `// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit
import Foundation
import CoreFoundation

enum EngineProtocol {
  static let maxPayload = ${spec.maxPayloadBytes}
  static let maxRate = ${spec.maxMessagesPerSecond}
  static let maxEnvelope = ${Math.ceil((spec.maxPayloadBytes + offset) / 3) * 4 + 64}
  static func valid(_ data: Data) -> Bool {
    let b = [UInt8](data)
    guard b.count >= ${offset}, b.count <= ${offset + spec.maxPayloadBytes}, b[${at("version")}] == ${spec.version},
      (${Math.min(...Object.values(spec.kinds))}...${Math.max(...Object.values(spec.kinds))}).contains(Int(b[${at("kind")}])),
      b[${at("source")}] <= ${Math.max(...Object.values(spec.lanes))}, b[${at("target")}] <= ${Math.max(...Object.values(spec.lanes))}, b[${at("source")}] != b[${at("target")}] else { return false }
    let length = (0..<4).reduce(UInt32(0)) { $0 | UInt32(b[${at("payloadLength")} + $1]) << ($1 * 8) }
    return Int(length) == b.count - ${offset}
  }
  static func decodeEnvelope(_ text: String) -> Data? {
    guard text.utf8.count <= maxEnvelope, let json = text.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any], object.count == 2,
      let marker = object["${spec.envelope.marker}"] as? NSNumber, CFGetTypeID(marker) != CFBooleanGetTypeID(), marker.doubleValue == ${spec.envelope.version},
      let encoded = object["${spec.envelope.field}"] as? String, let bytes = Data(base64Encoded: encoded),
      bytes.base64EncodedString() == encoded, valid(bytes) else { return nil }
    return bytes
  }
  static func envelope(_ bytes: Data) -> String? {
    guard valid(bytes), let json = try? JSONSerialization.data(withJSONObject: ["${spec.envelope.marker}": ${spec.envelope.version}, "${spec.envelope.field}": bytes.base64EncodedString()]) else { return nil }
    return String(data: json, encoding: .utf8)
  }
  static func command(topic: UInt32, payload: Data = Data()) -> Data? {
    guard payload.count <= maxPayload else { return nil }
    var bytes = [UInt8](repeating: 0, count: ${offset})
    bytes[${at("version")}] = ${spec.version}; bytes[${at("kind")}] = ${spec.kinds.COMMAND}
    bytes[${at("source")}] = ${spec.lanes.NATIVE}; bytes[${at("target")}] = ${spec.lanes.ENGINE}
    for shift in 0..<4 {
      bytes[${at("topic")} + shift] = UInt8(truncatingIfNeeded: topic >> (shift * 8))
      bytes[${at("payloadLength")} + shift] = UInt8(truncatingIfNeeded: payload.count >> (shift * 8))
    }
    return Data(bytes) + payload
  }
  static func payload(_ bytes: Data) -> Data { bytes.dropFirst(${offset}) }
  static func fromEngineToNative(_ bytes: Data) -> Bool { valid(bytes) && bytes[${at("source")}] == ${spec.lanes.ENGINE} && bytes[${at("target")}] == ${spec.lanes.NATIVE} }
}
`;
const java = `// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit
package dev.nativetron.app;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import org.json.JSONObject;

final class EngineProtocol {
  static final int MAX_PAYLOAD = ${spec.maxPayloadBytes};
  static final int MAX_RATE = ${spec.maxMessagesPerSecond};
  static boolean valid(byte[] bytes) {
    if (bytes.length < ${offset} || bytes.length > ${offset + spec.maxPayloadBytes}) return false;
    ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    return b.get(${at("version")}) == ${spec.version} && b.get(${at("kind")}) >= ${Math.min(...Object.values(spec.kinds))} && b.get(${at("kind")}) <= ${Math.max(...Object.values(spec.kinds))} &&
      b.get(${at("source")}) >= 0 && b.get(${at("source")}) <= ${Math.max(...Object.values(spec.lanes))} && b.get(${at("target")}) >= 0 && b.get(${at("target")}) <= ${Math.max(...Object.values(spec.lanes))} && b.get(${at("source")}) != b.get(${at("target")}) &&
      b.getInt(${at("payloadLength")}) == bytes.length - ${offset};
  }
  static byte[] decodeEnvelope(String text) {
    if (text.length() > ${Math.ceil((spec.maxPayloadBytes + offset) / 3) * 4 + 64}) return null;
    try {
      JSONObject object = new JSONObject(text);
      if (object.length() != 2 || !(object.get("${spec.envelope.marker}") instanceof Integer) || object.getInt("${spec.envelope.marker}") != ${spec.envelope.version} || !(object.get("${spec.envelope.field}") instanceof String)) return null;
      String value = object.getString("${spec.envelope.field}");
      byte[] bytes = Base64.decode(value, Base64.NO_WRAP);
      return Base64.encodeToString(bytes, Base64.NO_WRAP).equals(value) && valid(bytes) ? bytes : null;
    } catch (Exception error) { return null; }
  }
  static byte[] command(int topic, byte[] payload) {
    if (payload.length > MAX_PAYLOAD) throw new IllegalArgumentException("engine payload too large");
    ByteBuffer b = ByteBuffer.allocate(${offset} + payload.length).order(ByteOrder.LITTLE_ENDIAN);
    b.put(${at("version")}, (byte)${spec.version}); b.put(${at("kind")}, (byte)${spec.kinds.COMMAND}); b.put(${at("source")}, (byte)${spec.lanes.NATIVE}); b.put(${at("target")}, (byte)${spec.lanes.ENGINE});
    b.putInt(${at("topic")}, topic); b.putInt(${at("payloadLength")}, payload.length);
    b.position(${offset}); b.put(payload); return b.array();
  }
  static byte[] payload(byte[] bytes) { return Arrays.copyOfRange(bytes, ${offset}, bytes.length); }
  static boolean fromEngineToNative(byte[] bytes) { return valid(bytes) && bytes[${at("source")}] == ${spec.lanes.ENGINE} && bytes[${at("target")}] == ${spec.lanes.NATIVE}; }
}
`;
const cpp = `// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit
#pragma once
#include <cstdint>
#include <string>
#include <vector>
namespace nt_engine {
constexpr size_t header_bytes = ${offset};
constexpr size_t max_payload = ${spec.maxPayloadBytes};
constexpr size_t max_rate = ${spec.maxMessagesPerSecond};
inline uint32_t read_u32(const std::vector<uint8_t> &b, size_t offset) {
  return uint32_t(b[offset]) | (uint32_t(b[offset + 1]) << 8) | (uint32_t(b[offset + 2]) << 16) | (uint32_t(b[offset + 3]) << 24);
}
inline bool valid(const std::vector<uint8_t> &b) {
  return b.size() >= header_bytes && b.size() <= header_bytes + max_payload && b[${at("version")}] == ${spec.version} &&
    b[${at("kind")}] >= ${Math.min(...Object.values(spec.kinds))} && b[${at("kind")}] <= ${Math.max(...Object.values(spec.kinds))} &&
    b[${at("source")}] <= ${Math.max(...Object.values(spec.lanes))} && b[${at("target")}] <= ${Math.max(...Object.values(spec.lanes))} && b[${at("source")}] != b[${at("target")}] && read_u32(b, ${at("payloadLength")}) == b.size() - header_bytes;
}
inline std::vector<uint8_t> command(uint32_t topic) {
  std::vector<uint8_t> bytes(header_bytes);
  bytes[${at("version")}] = ${spec.version}; bytes[${at("kind")}] = ${spec.kinds.COMMAND}; bytes[${at("source")}] = ${spec.lanes.NATIVE}; bytes[${at("target")}] = ${spec.lanes.ENGINE};
  for (size_t shift = 0; shift < 4; shift++) bytes[${at("topic")} + shift] = static_cast<uint8_t>(topic >> (shift * 8));
  return bytes;
}
inline std::string base64(const std::vector<uint8_t> &bytes) {
  const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < bytes.size(); i += 3) {
    uint32_t value = uint32_t(bytes[i]) << 16;
    if (i + 1 < bytes.size()) value |= uint32_t(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size()) value |= bytes[i + 2];
    out += alphabet[value >> 18]; out += alphabet[(value >> 12) & 63];
    out += i + 1 < bytes.size() ? alphabet[(value >> 6) & 63] : '=';
    out += i + 2 < bytes.size() ? alphabet[value & 63] : '=';
  }
  return out;
}
inline std::vector<uint8_t> from_base64(const std::string &text) {
  if (text.size() > ${Math.ceil((spec.maxPayloadBytes + offset) / 3) * 4} || text.size() % 4) return {};
  const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<uint8_t> bytes;
  uint32_t value = 0; int bits = 0;
  for (char c : text) {
    if (c == '=') break;
    size_t digit = alphabet.find(c); if (digit == std::string::npos) return {};
    value = (value << 6) | static_cast<uint32_t>(digit); bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push_back(static_cast<uint8_t>(value >> bits)); }
  }
  return valid(bytes) && base64(bytes) == text ? bytes : std::vector<uint8_t>{};
}
inline bool from_engine_to_native(const std::vector<uint8_t> &bytes) { return valid(bytes) && bytes[${at("source")}] == ${spec.lanes.ENGINE} && bytes[${at("target")}] == ${spec.lanes.NATIVE}; }
inline std::string envelope(const std::string &encoded) { return "{\\\"${spec.envelope.marker}\\\":${spec.envelope.version},\\\"${spec.envelope.field}\\\":\\\"" + encoded + "\\\"}"; }
}
`;
const outputs = [
  ["engine.generated.h", cpp],
  ["../hosts/ios/Sources/EngineProtocol.generated.swift", swift],
  ["../hosts/android/src/dev/nativetron/app/EngineProtocol.java", java],
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
  if (check) console.error(`stale: ${path}`); else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, next); }
}
if (check && stale) process.exit(1);
console.log(`engine IPC: ${check ? "generated files up to date" : `wrote ${stale} files`}`);
