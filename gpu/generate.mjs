import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "ops.json"), "utf8"));
const check = process.argv.includes("--check");
const supported = new Set(["u32", "i32", "f32", "f64", "bool", "str", "handle", "handle[]", "u32[]", "f64[]", "upload", "readback"]);
const camel = (name) => name.toLowerCase().replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const upper = (name) => name.toUpperCase();
const parsed = (arg) => {
  const at = arg.lastIndexOf(":");
  if (at < 1) throw new Error(`invalid GPU argument ${arg}`);
  const name = arg.slice(0, at);
  const type = arg.slice(at + 1);
  if (!supported.has(type)) throw new Error(`unsupported GPU argument type ${type}`);
  return { name, type };
};

const codes = new Set();
for (const op of spec.ops) {
  if (!Number.isInteger(op.code) || op.code < 1 || op.code > 255 || codes.has(op.code)) throw new Error(`invalid GPU opcode ${op.code}`);
  codes.add(op.code);
  op.args = op.args.map(parsed);
}

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

const guestImports = new Set(["u8", "u32", "i32", "f32", "f64", "str", "u32Array", "f64Array", "upload", "readback", "allocateHandle", "releaseHandle"]);
const guestFunctions = spec.ops.map((op) => {
  const name = camel(op.name);
  const args = op.args.map((arg) => `${arg.name}: ${tsType(arg.type)}`).join(", ");
  const result = op.result ? "number" : "void";
  const lines = [`export function ${name}(${args}): ${result} {`];
  if (op.result) lines.push("  const handle = allocateHandle();");
  lines.push(`  u8(${op.code});`);
  if (op.result) lines.push("  u32(handle);");
  for (const arg of op.args) lines.push(`  ${writeArg(arg)}`);
  if ((op.name === "DESTROY" || op.name === "RELEASE")) lines.push("  releaseHandle(resource);");
  if (op.result) lines.push("  return handle;");
  lines.push("}");
  return lines.join("\n");
}).join("\n\n");

const limits = `// generated from gpu/ops.json by gpu/generate.mjs — do not edit\n` +
  `export const MAX_BATCH_BYTES = ${spec.maxBatchBytes};\n` +
  `export const MAX_UPLOAD_BYTES = ${spec.maxUploadBytes};\n` +
  `export const MAX_READBACK_BYTES = ${spec.maxReadbackBytes};\n` +
  `export const MAX_ARRAY_LENGTH = ${spec.maxArrayLength};\n` +
  `export const SLOT_MASK = ${2 ** spec.handle.slotBits - 1};\n` +
  `export const GENERATION_MASK = ${2 ** spec.handle.generationBits - 1};\n` +
  `export const GENERATION_SHIFT = ${spec.handle.slotBits};\n`;

const guest = `// generated from gpu/ops.json by gpu/generate.mjs — do not edit\n` +
  `import { ${[...guestImports].join(", ")}, type UploadSlice, type ReadbackSlice } from "./encode.js";\n\n` +
  Object.entries(spec.constants).map(([name, value]) => `export const ${name} = ${value};`).join("\n") + "\n\n" +
  spec.events.map((event) => `export const GPU_EVENT_${upper(event.name)} = ${event.code};`).join("\n") + "\n\n" +
  guestFunctions + "\n";

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
const cases = spec.ops.map((op) => {
  if (op.args.some(arg => arg.name === "requestId")) {
    const argumentsToRead = [...(op.result ? [{ name: "handle", type: "handle" }] : []), ...op.args];
    const resource = argumentsToRead.find(arg => arg.type === "handle")?.name;
    const reads = argumentsToRead.map(arg => `const ${arg.name} = ${hostRead(arg)};${arg.name === "requestId" ? " activeRequest = requestId;" : ""}${arg.name === resource ? ` activeHandle = ${resource};` : ""}`).join(" ");
    return `        case ${op.code}: { ${reads} host.${camel(op.name)}(${argumentsToRead.map(arg => arg.name).join(", ")}); break; }`;
  }
  const reads = [];
  if (op.result) reads.push("u32()");
  for (const arg of op.args) reads.push(hostRead(arg));
  return `        case ${op.code}: host.${camel(op.name)}(${reads.join(", ")}); break;`;
}).join("\n");

const fixedLayouts = {};
for (const op of spec.ops) {
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

const host = `// generated from gpu/ops.json by gpu/generate.mjs — do not edit\n` +
  Object.entries(spec.constants).map(([name, value]) => `export const ${name} = ${value};`).join("\n") + "\n" +
  spec.events.map((event) => `export const GPU_EVENT_${upper(event.name)} = ${event.code};`).join("\n") + `\n\n` +
`export const GPU_PROTOCOL_VERSION = ${spec.version};
export const GPU_MAX_BATCH_BYTES = ${spec.maxBatchBytes};
export const GPU_TERMINAL_EVENTS = new Set(${JSON.stringify(spec.events.filter(event => event.terminal).map(event => event.code))});
export const GPU_MAX_ARRAY_LENGTH = ${spec.maxArrayLength};
export const GPU_HANDLE_SLOT_BITS = ${spec.handle.slotBits};
export const GPU_HANDLE_GENERATION_BITS = ${spec.handle.generationBits};
export const GPU_MAX_PENDING_REQUESTS = ${spec.maxPendingRequests};
export const GPU_ENUMS = ${JSON.stringify(spec.enums, null, 2)};
export const GPU_RECORDS = ${JSON.stringify(spec.records, null, 2)};
export const GPU_FIXED_LAYOUTS = ${JSON.stringify(fixedLayouts, null, 2)};

export function readGpuRecord(kind, values, offset = 0) {
  const fields = GPU_RECORDS[kind];
  if (!fields || offset + fields.length > values.length) throw new Error("truncated GPU descriptor record");
  const record = {};
  for (let i = 0; i < fields.length; i++) record[fields[i]] = values[offset + i];
  return { record, next: offset + fields.length };
}

const decoder = new TextDecoder();

export function decodeGpuBatch(host, bytes) {
  let activeRequest = 0, activeHandle = 0;
  try {
    if (!(bytes instanceof Uint8Array)) throw new Error("GPU batch is not bytes");
    if (bytes.byteLength > GPU_MAX_BATCH_BYTES) throw new Error("GPU batch limit exceeded");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const need = (length) => { if (length < 0 || offset + length > bytes.byteLength) throw new Error("truncated GPU batch"); };
    const u8 = () => { need(1); return bytes[offset++]; };
    const bool = () => { const value = u8(); if (value > 1) throw new Error("invalid GPU boolean"); return value !== 0; };
    const u32 = () => { need(4); const value = view.getUint32(offset, true); offset += 4; return value; };
    const i32 = () => { need(4); const value = view.getInt32(offset, true); offset += 4; return value; };
    const f32 = () => { need(4); const value = view.getFloat32(offset, true); offset += 4; return value; };
    const f64 = () => { need(8); const value = view.getFloat64(offset, true); offset += 8; return value; };
    const str = () => { const length = u32(); need(length); const value = decoder.decode(bytes.subarray(offset, offset + length)); offset += length; return value; };
    const count = () => { const value = u32(); if (value > GPU_MAX_ARRAY_LENGTH) throw new Error("GPU array limit exceeded"); return value; };
    const u32Array = () => { const length = count(); const values = new Array(length); for (let i = 0; i < length; i++) values[i] = u32(); return values; };
    const f64Array = () => { const length = count(); const values = new Array(length); for (let i = 0; i < length; i++) values[i] = f64(); return values; };
    const range = (readback) => ({ offset: u32(), length: u32(), readback });
    while (offset < bytes.byteLength) {
      activeRequest = 0; activeHandle = 0;
      switch (u8()) {
${cases}
        default: throw new Error("unknown GPU opcode");
      }
    }
    return true;
  } catch (error) {
    host.protocolError(error instanceof Error ? error.message : String(error), activeRequest, activeHandle);
    return false;
  }
}
`;

const table = [
  "| opcode | operation | result | arguments |",
  "|---:|---|---|---|",
  ...spec.ops.map((op) => `| ${op.code} | \`${camel(op.name)}\` | ${op.result ?? "—"} | ${op.args.map((arg) => `${arg.name}: ${arg.type}`).join(", ") || "—"} |`),
].join("\n");
const eventTable = [
  "| code | event |",
  "|---:|---|",
  ...spec.events.map((event) => `| ${event.code} | ${event.name} |`),
].join("\n");

const targets = [
  { path: join(here, "gpu.generated.ts"), next: guest },
  { path: join(here, "limits.generated.ts"), next: limits },
  { path: join(here, "gpu-host.generated.js"), next: host },
  {
    path: join(here, "README.md"),
    render: (previous) => previous
      .replace(/<!-- generated:ops -->[\s\S]*?<!-- \/generated:ops -->/, `<!-- generated:ops -->\n${table}\n<!-- /generated:ops -->`)
      .replace(/<!-- generated:events -->[\s\S]*?<!-- \/generated:events -->/, `<!-- generated:events -->\n${eventTable}\n<!-- /generated:events -->`),
  },
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
