import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "ops.json"), "utf8");
const spec = JSON.parse(source);
const check = process.argv.includes("--check");
const supported = new Set(["u32", "i32", "f32", "f64", "bool", "str", "handle", "handle[]", "u32[]", "f64[]", "upload", "readback"]);
const camel = (name) => name.toLowerCase().replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const pascal = (name) => name[0].toUpperCase() + name.slice(1);
const upper = (name) => name.toUpperCase();
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([a-zA-Z])([0-9])/g, "$1_$2").toUpperCase();
const constantName = (value) => value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const fail = (message) => { throw new Error(`gpu/ops.json: ${message}`); };
const parsed = (arg) => {
  const at = arg.lastIndexOf(":");
  if (at < 1) fail(`invalid GPU argument ${arg}`);
  const name = arg.slice(0, at);
  const type = arg.slice(at + 1);
  if (!supported.has(type)) fail(`unsupported GPU argument type ${type}`);
  return { name, type };
};

// The identity covers the whole schema, so any wire, enum, record or bound change produces a new value.
function fnv1a(text) {
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(text, "utf8");
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash >>> 0;
}
const identity = fnv1a(JSON.stringify(spec));
const identityHex = `0x${identity.toString(16).padStart(8, "0")}`;

const events = new Map(spec.events.map((event) => [event.name, event]));
const codes = new Set();
let header = null;
for (const op of spec.ops) {
  if (!Number.isInteger(op.code) || op.code < 1 || op.code > 255 || codes.has(op.code)) fail(`invalid GPU opcode ${op.code}`);
  codes.add(op.code);
  op.args = op.args.map(parsed);
  const names = new Set(op.args.map((arg) => arg.name));
  if (names.size !== op.args.length || names.has("handle")) fail(`${op.name} has duplicate or reserved argument names`);
  const request = names.has("requestId");
  if (request !== Boolean(op.completes)) fail(`${op.name}: requestId operations must name exactly one completion event`);
  if (op.completes && !events.get(op.completes)?.terminal) fail(`${op.name} completes with non-terminal event ${op.completes}`);
  if (op.header) {
    if (header || op.result || op.control || op.args.map((arg) => `${arg.name}:${arg.type}`).join() !== "version:u32,identity:u32") fail("invalid protocol header operation");
    header = op;
  }
}
if (!header) fail("missing protocol header operation");
const wireOps = spec.ops.filter((op) => !op.header);
const headerBytes = 9;

for (const [name, fields] of Object.entries(spec.records)) {
  if (new Set(fields).size !== fields.length || !fields.length) fail(`record ${name} has duplicate fields`);
}
if (spec.features.length > 31 || new Set(spec.features).size !== spec.features.length) fail("feature bits must be unique and fit in 31 bits");
if (spec.limits[0] !== null || new Set(spec.limits.slice(1).map((limit) => limit.name)).size !== spec.limits.length - 1) fail("limits must be unique and one-based");
for (const limit of spec.limits.slice(1)) if (limit.class !== "maximum" && limit.class !== "alignment") fail(`limit ${limit.name} has unknown class`);
if (spec.statuses.some((status, index) => status.code !== index)) fail("statuses must be dense from zero");

const constants = new Map();
const define = (name, value, origin) => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail(`invalid constant ${name}`);
  if (constants.has(name) && constants.get(name).value !== value) fail(`constant ${name} conflicts (${origin})`);
  if (!constants.has(name)) constants.set(name, { value, origin });
};
for (const [name, value] of Object.entries(spec.constants)) define(name, value, "constants");
for (const [table, prefix] of Object.entries(spec.enumConstants)) {
  const values = spec.enums[table];
  if (!values) fail(`enumConstants names unknown enum ${table}`);
  values.forEach((value, index) => { if (value !== null) define(`${prefix}_${constantName(value)}`, index, `enum ${table}`); });
}
spec.features.forEach((feature, bit) => define(`FEATURE_${constantName(feature)}`, 2 ** bit, "features"));
spec.limits.forEach((limit, index) => { if (limit) define(`LIMIT_${snake(limit.name)}`, index, "limits"); });
for (const [name, fields] of Object.entries(spec.records)) define(`RECORD_${snake(name)}_WIDTH`, fields.length, "records");
const constantLines = [...constants].map(([name, { value }]) => `export const ${name} = ${value};`).join("\n");
const eventLines = spec.events.map((event) => `export const GPU_EVENT_${upper(event.name)} = ${event.code};`).join("\n");
const statusLines = spec.statuses.map((status) => `export const GPU_STATUS_${upper(status.name)} = ${status.code};`).join("\n");

const tsType = (type) => {
  if (type === "str") return "string";
  if (type === "bool") return "boolean";
  if (type === "handle[]" || type === "u32[]" || type === "f64[]") return "number[]";
  if (type === "upload") return "UploadSlice";
  if (type === "readback") return "ReadbackSlice";
  return "number";
};
const writeArg = ({ name, type }) => {
  if (type === "bool") return `u8(${name} ? 1 : 0);`;
  if (type === "handle[]" || type === "u32[]") return `u32Array(${name});`;
  if (type === "f64[]") return `f64Array(${name});`;
  if (type === "handle") return `u32(${name});`;
  return `${type}(${name});`;
};

const guestImports = ["begin", "beginResult", "end", "u8", "u32", "i32", "f32", "f64", "str", "u32Array", "f64Array", "upload", "readback", "releaseHandle"];
const guestFunctions = wireOps.map((op) => {
  const name = camel(op.name);
  const args = op.args.map((arg) => `${arg.name}: ${tsType(arg.type)}`).join(", ");
  const result = op.result ? "number" : "void";
  const lines = [`export function ${name}(${args}): ${result} {`];
  lines.push(op.result ? `  const handle = beginResult(${op.code});` : `  begin(${op.code});`);
  for (const arg of op.args) lines.push(`  ${writeArg(arg)}`);
  lines.push("  end();");
  if (op.name === "DESTROY" || op.name === "RELEASE") lines.push("  releaseHandle(resource);");
  if (op.result) lines.push("  return handle;");
  lines.push("}");
  return lines.join("\n");
}).join("\n\n");
const recordBuilders = Object.entries(spec.records).map(([name, fields]) => [
  `export function record${pascal(name)}(out: number[], ${fields.map((field) => `${field}: number`).join(", ")}): number[] {`,
  ...fields.map((field) => `  out.push(${field});`),
  "  return out;",
  "}",
].join("\n")).join("\n\n");

const limits = `// generated from gpu/ops.json by gpu/generate.mjs — do not edit\n` +
  `export const MAX_BATCH_BYTES = ${spec.maxBatchBytes};\n` +
  `export const MAX_UPLOAD_BYTES = ${spec.maxUploadBytes};\n` +
  `export const MAX_READBACK_BYTES = ${spec.maxReadbackBytes};\n` +
  `export const MAX_ARRAY_LENGTH = ${spec.maxArrayLength};\n` +
  `export const SLOT_MASK = ${2 ** spec.handle.slotBits - 1};\n` +
  `export const GENERATION_MASK = ${2 ** spec.handle.generationBits - 1};\n` +
  `export const GENERATION_SHIFT = ${spec.handle.slotBits};\n` +
  `export const PROTOCOL_OPCODE = ${header.code};\n` +
  `export const PROTOCOL_VERSION = ${spec.version};\n` +
  `export const PROTOCOL_IDENTITY = ${identityHex};\n` +
  `export const PROTOCOL_HEADER_BYTES = ${headerBytes};\n`;

const guest = `// generated from gpu/ops.json by gpu/generate.mjs — do not edit\n` +
  `import { ${guestImports.join(", ")}, type UploadSlice, type ReadbackSlice } from "./encode.js";\n\n` +
  `export const GPU_PROTOCOL_VERSION = ${spec.version};\nexport const GPU_PROTOCOL_IDENTITY = ${identityHex};\n\n` +
  constantLines + "\n\n" + eventLines + "\n\n" + statusLines + "\n\n" +
  guestFunctions + "\n\n" + recordBuilders + "\n";

const hostRead = (arg) => {
  if (arg.type === "u32" || arg.type === "handle") return "u32()";
  if (arg.type === "i32") return "i32()";
  if (arg.type === "f32") return "f32()";
  if (arg.type === "f64") return "f64()";
  if (arg.type === "bool") return "bool()";
  if (arg.type === "str") return "str()";
  if (arg.type === "handle[]" || arg.type === "u32[]") return "u32Array()";
  if (arg.type === "f64[]") return "f64Array()";
  if (arg.type === "upload") return "range(false)";
  if (arg.type === "readback") return "range(true)";
  throw new Error(`no host reader for ${arg.type}`);
};
const cases = wireOps.map((op) => {
  const operands = [...(op.result ? [{ name: "handle", type: "handle" }] : []), ...op.args];
  const request = op.args.some((arg) => arg.name === "requestId");
  const resource = operands.find((arg) => arg.type === "handle")?.name;
  const names = operands.map((arg) => `v_${arg.name}`);
  const reads = operands.length ? `const ${operands.map((arg) => `v_${arg.name} = ${hostRead(arg)}`).join(", ")}; ` : "";
  const tracking = (request ? "activeRequest = v_requestId; " : "") + (request && resource ? `activeHandle = v_${resource}; ` : "");
  const call = `host.${camel(op.name)}(${names.join(", ")})`;
  let skipped = "";
  if (op.control) skipped = `try { ${call}; } catch {}`;
  else if (request) skipped = `host.skipRequest(v_requestId, ${events.get(op.completes).code}, ${resource ? `v_${resource}` : "0"});`;
  const body = skipped ? `if (aborted) { ${skipped} } else ${call};` : `if (!aborted) ${call};`;
  return `        case ${op.code}: { ${reads}${tracking}${body} break; }`;
}).join("\n");

const fixedLayouts = {};
for (const op of wireOps) {
  let offset = 1;
  const fields = {};
  if (op.result) { fields.handle = offset; offset += 4; }
  for (const arg of op.args) {
    const size = ({ u32: 4, i32: 4, f32: 4, f64: 8, bool: 1, handle: 4, upload: 8, readback: 8 })[arg.type];
    if (!size) { offset = 0; break; }
    fields[arg.name] = offset; offset += size;
  }
  if (offset) fixedLayouts[camel(op.name)] = { code: op.code, bytes: offset, fields };
}
const requestEvents = Object.fromEntries(spec.ops.filter((op) => op.completes).map((op) => [camel(op.name), events.get(op.completes).code]));

const host = `// generated from gpu/ops.json by gpu/generate.mjs — do not edit\n` +
  constantLines + "\n" + eventLines + "\n" + statusLines + `\n\n` +
`export const GPU_PROTOCOL_VERSION = ${spec.version};
export const GPU_PROTOCOL_IDENTITY = ${identityHex};
export const GPU_PROTOCOL_OPCODE = ${header.code};
export const GPU_PROTOCOL_HEADER_BYTES = ${headerBytes};
export const GPU_MAX_BATCH_BYTES = ${spec.maxBatchBytes};
export const GPU_TERMINAL_EVENTS = new Set(${JSON.stringify(spec.events.filter(event => event.terminal).map(event => event.code))});
export const GPU_MAX_ARRAY_LENGTH = ${spec.maxArrayLength};
export const GPU_HANDLE_SLOT_BITS = ${spec.handle.slotBits};
export const GPU_HANDLE_GENERATION_BITS = ${spec.handle.generationBits};
export const GPU_MAX_PENDING_REQUESTS = ${spec.maxPendingRequests};
export const GPU_ENUMS = ${JSON.stringify(spec.enums, null, 2)};
export const GPU_RECORDS = ${JSON.stringify(spec.records, null, 2)};
export const GPU_FEATURES = ${JSON.stringify(spec.features, null, 2)};
export const GPU_LIMITS = ${JSON.stringify(spec.limits, null, 2)};
export const GPU_REQUEST_EVENTS = ${JSON.stringify(requestEvents, null, 2)};
export const GPU_FIXED_LAYOUTS = ${JSON.stringify(fixedLayouts, null, 2)};

// Decoding failures are fatal for the rest of the batch; host-side rejections are not.
export class GpuProtocolError extends Error {}

export function writeGpuProtocolHeader(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, GPU_PROTOCOL_HEADER_BYTES);
  view.setUint8(0, GPU_PROTOCOL_OPCODE);
  view.setUint32(1, GPU_PROTOCOL_VERSION, true);
  view.setUint32(5, GPU_PROTOCOL_IDENTITY, true);
  return offset + GPU_PROTOCOL_HEADER_BYTES;
}

export function readGpuRecord(kind, values, offset = 0) {
  const fields = GPU_RECORDS[kind];
  if (!fields || offset + fields.length > values.length) throw new Error("truncated GPU descriptor record");
  const record = {};
  for (let i = 0; i < fields.length; i++) record[fields[i]] = values[offset + i];
  return { record, next: offset + fields.length };
}

const decoder = new TextDecoder();

export function decodeGpuBatch(host, bytes) {
  let activeRequest = 0, activeHandle = 0, aborted = false;
  let offset = 0;
  try {
    if (!(bytes instanceof Uint8Array)) throw new GpuProtocolError("GPU batch is not bytes");
    if (bytes.byteLength > GPU_MAX_BATCH_BYTES) throw new GpuProtocolError("GPU batch limit exceeded");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < GPU_PROTOCOL_HEADER_BYTES || bytes[0] !== GPU_PROTOCOL_OPCODE) throw new GpuProtocolError("GPU batch has no protocol header");
    if (view.getUint32(1, true) !== GPU_PROTOCOL_VERSION || view.getUint32(5, true) !== GPU_PROTOCOL_IDENTITY) throw new GpuProtocolError("GPU protocol version or identity mismatch");
    offset = GPU_PROTOCOL_HEADER_BYTES;
    const need = (length) => { if (length < 0 || offset + length > bytes.byteLength) throw new GpuProtocolError("truncated GPU batch"); };
    const u8 = () => { need(1); return bytes[offset++]; };
    const bool = () => { const value = u8(); if (value > 1) throw new GpuProtocolError("invalid GPU boolean"); return value !== 0; };
    const u32 = () => { need(4); const value = view.getUint32(offset, true); offset += 4; return value; };
    const i32 = () => { need(4); const value = view.getInt32(offset, true); offset += 4; return value; };
    const f32 = () => { need(4); const value = view.getFloat32(offset, true); offset += 4; return value; };
    const f64 = () => { need(8); const value = view.getFloat64(offset, true); offset += 8; return value; };
    const str = () => { const length = u32(); need(length); const value = decoder.decode(bytes.subarray(offset, offset + length)); offset += length; return value; };
    const count = () => { const value = u32(); if (value > GPU_MAX_ARRAY_LENGTH) throw new GpuProtocolError("GPU array limit exceeded"); return value; };
    const u32Array = () => { const length = count(); const values = new Array(length); for (let i = 0; i < length; i++) values[i] = u32(); return values; };
    const f64Array = () => { const length = count(); const values = new Array(length); for (let i = 0; i < length; i++) values[i] = f64(); return values; };
    const range = (readback) => ({ offset: u32(), length: u32(), readback });
    const run = () => {
      while (offset < bytes.byteLength) {
        activeRequest = 0; activeHandle = 0;
        switch (u8()) {
${cases}
          default: throw new GpuProtocolError("unknown GPU opcode");
        }
      }
    };
    // After a host-side rejection the remaining operations are still decoded: lifetime and control
    // operations execute so handle generations stay synchronized, and every request completes once.
    for (;;) {
      try { run(); return !aborted; }
      catch (error) {
        if (aborted || error instanceof GpuProtocolError) throw error;
        aborted = true;
        host.protocolError(error, activeRequest, activeHandle, false);
      }
    }
  } catch (error) {
    host.protocolError(error, activeRequest, activeHandle, true);
    return false;
  }
}
`;

const table = [
  "| opcode | operation | result | arguments |",
  "|---:|---|---|---|",
  ...spec.ops.map((op) => `| ${op.code} | ${op.header ? "batch header (generated)" : `\`${camel(op.name)}\``} | ${op.result ?? "—"} | ${op.args.map((arg) => `${arg.name}: ${arg.type}`).join(", ") || "—"} |`),
].join("\n");
const eventTable = [
  "| code | event | terminal |",
  "|---:|---|---|",
  ...spec.events.map((event) => `| ${event.code} | ${event.name} | ${event.terminal ? "yes" : "no"} |`),
].join("\n");
const statusTable = [
  "| status | name |",
  "|---:|---|",
  ...spec.statuses.map((status) => `| ${status.code} | \`GPU_STATUS_${status.name}\` |`),
].join("\n");
const requestTable = [
  "| operation | completion event | executes after a rejected operation in the same batch |",
  "|---|---|---|",
  ...wireOps.filter((op) => op.completes || op.control).map((op) => `| \`${camel(op.name)}\` | ${op.completes ?? "—"} | ${op.control ? "yes" : `no; completes with CANCELLED`} |`),
].join("\n");
const recordTable = [
  "| record | width | fields |",
  "|---|---:|---|",
  ...Object.entries(spec.records).map(([name, fields]) => `| \`${name}\` (\`record${pascal(name)}\`) | ${fields.length} | ${fields.join(", ")} |`),
].join("\n");
const enumTable = [
  "| enum | constants | values |",
  "|---|---|---|",
  ...Object.entries(spec.enums).map(([name, values]) => `| \`${name}\` | ${spec.enumConstants[name] ? `\`${spec.enumConstants[name]}_*\`` : "—"} | ${values.map((value, index) => value === null ? null : `${index} ${value}`).filter(Boolean).join(", ")} |`),
].join("\n");
const featureTable = [
  "| bit value | feature |",
  "|---:|---|",
  ...spec.features.map((feature, bit) => `| ${2 ** bit} | \`${feature}\` |`),
].join("\n");
const limitTable = [
  "| id | limit | class |",
  "|---:|---|---|",
  ...spec.limits.slice(1).map((limit, index) => `| ${index + 1} | \`${limit.name}\` | ${limit.class} |`),
].join("\n");
const protocolText = `Protocol version ${spec.version}, identity \`${identityHex}\` (FNV-1a of \`gpu/ops.json\`). Every batch starts with the ${headerBytes}-byte header: opcode ${header.code}, u32 version, u32 identity, little-endian.`;

const sections = { ops: table, events: eventTable, statuses: statusTable, requests: requestTable, records: recordTable, enums: enumTable, features: featureTable, limits: limitTable, protocol: protocolText };
const renderReadme = (previous) => {
  let next = previous;
  for (const [name, content] of Object.entries(sections)) {
    const pattern = new RegExp(`<!-- generated:${name} -->[\\s\\S]*?<!-- /generated:${name} -->`);
    if (!pattern.test(next)) fail(`gpu/README.md is missing the generated:${name} section`);
    next = next.replace(pattern, `<!-- generated:${name} -->\n${content}\n<!-- /generated:${name} -->`);
  }
  return next;
};

const targets = [
  { path: join(here, "gpu.generated.ts"), next: guest },
  { path: join(here, "limits.generated.ts"), next: limits },
  { path: join(here, "gpu-host.generated.js"), next: host },
  { path: join(here, "README.md"), render: renderReadme },
];

let stale = 0;
for (const target of targets) {
  const previous = (() => { try { return readFileSync(target.path, "utf8"); } catch { return ""; } })();
  const next = target.next ?? target.render(previous);
  if (next === previous) continue;
  stale++;
  if (check) console.error(`stale: ${target.path}`);
  else writeFileSync(target.path, next);
}
if (check && stale) {
  console.error(`${stale} GPU file(s) out of date — run: node gpu/generate.mjs`);
  process.exit(1);
}
console.log(check ? "gpu: generated files up to date" : `gpu: wrote ${stale} file(s)`);
