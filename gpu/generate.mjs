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

// Fatal decoding failures, shared by the JS host decoder and the native decoder so both report the same text.
const decodeFailures = {
  notBytes: "GPU batch is not bytes",
  batchLimit: "GPU batch limit exceeded",
  noHeader: "GPU batch has no protocol header",
  protocolMismatch: "GPU protocol version or identity mismatch",
  truncated: "truncated GPU batch",
  invalidBoolean: "invalid GPU boolean",
  arrayLimit: "GPU array limit exceeded",
  unknownOpcode: "unknown GPU opcode",
};

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
    if (!(bytes instanceof Uint8Array)) throw new GpuProtocolError(${JSON.stringify(decodeFailures.notBytes)});
    if (bytes.byteLength > GPU_MAX_BATCH_BYTES) throw new GpuProtocolError(${JSON.stringify(decodeFailures.batchLimit)});
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < GPU_PROTOCOL_HEADER_BYTES || bytes[0] !== GPU_PROTOCOL_OPCODE) throw new GpuProtocolError(${JSON.stringify(decodeFailures.noHeader)});
    if (view.getUint32(1, true) !== GPU_PROTOCOL_VERSION || view.getUint32(5, true) !== GPU_PROTOCOL_IDENTITY) throw new GpuProtocolError(${JSON.stringify(decodeFailures.protocolMismatch)});
    offset = GPU_PROTOCOL_HEADER_BYTES;
    const need = (length) => { if (length < 0 || offset + length > bytes.byteLength) throw new GpuProtocolError(${JSON.stringify(decodeFailures.truncated)}); };
    const u8 = () => { need(1); return bytes[offset++]; };
    const bool = () => { const value = u8(); if (value > 1) throw new GpuProtocolError(${JSON.stringify(decodeFailures.invalidBoolean)}); return value !== 0; };
    const u32 = () => { need(4); const value = view.getUint32(offset, true); offset += 4; return value; };
    const i32 = () => { need(4); const value = view.getInt32(offset, true); offset += 4; return value; };
    const f32 = () => { need(4); const value = view.getFloat32(offset, true); offset += 4; return value; };
    const f64 = () => { need(8); const value = view.getFloat64(offset, true); offset += 8; return value; };
    const str = () => { const length = u32(); need(length); const value = decoder.decode(bytes.subarray(offset, offset + length)); offset += length; return value; };
    const count = () => { const value = u32(); if (value > GPU_MAX_ARRAY_LENGTH) throw new GpuProtocolError(${JSON.stringify(decodeFailures.arrayLimit)}); return value; };
    const u32Array = () => { const length = count(); const values = new Array(length); for (let i = 0; i < length; i++) values[i] = u32(); return values; };
    const f64Array = () => { const length = count(); const values = new Array(length); for (let i = 0; i < length; i++) values[i] = f64(); return values; };
    const range = (readback) => ({ offset: u32(), length: u32(), readback });
    const run = () => {
      while (offset < bytes.byteLength) {
        activeRequest = 0; activeHandle = 0;
        switch (u8()) {
${cases}
          default: throw new GpuProtocolError(${JSON.stringify(decodeFailures.unknownOpcode)});
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

// Native decoder: a portable C++17 header with the same wire contract as decodeGpuBatch above.
const cxxKeywords = new Set(["alignas", "alignof", "and", "asm", "auto", "bool", "break", "case", "catch", "char", "class", "const", "constexpr", "continue", "default", "delete", "do", "double", "else", "enum", "explicit", "export", "extern", "false", "float", "for", "friend", "goto", "if", "inline", "int", "long", "mutable", "namespace", "new", "noexcept", "not", "nullptr", "operator", "or", "private", "protected", "public", "register", "return", "short", "signed", "sizeof", "static", "struct", "switch", "template", "this", "throw", "true", "try", "typedef", "typename", "union", "unsigned", "using", "virtual", "void", "volatile", "while", "xor"]);
const cxxIdentifier = (name, origin) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || cxxKeywords.has(name)) fail(`${origin} ${name} is not a portable C++ identifier`);
  return name;
};
const cxxString = (value) => {
  if (!/^[\x20-\x7e]*$/.test(value)) fail(`native string ${value} is not printable ASCII`);
  return JSON.stringify(value);
};
const cxxTypes = { u32: "uint32_t", i32: "int32_t", f32: "float", f64: "double", bool: "bool", str: "Str", handle: "Handle", "handle[]": "HandleArray", "u32[]": "U32Array", "f64[]": "F64Array", upload: "UploadRange", readback: "ReadbackRange" };
const cxxReaders = { u32: "u32", i32: "i32", f32: "f32", f64: "f64", bool: "boolean", str: "str", handle: "handle", "handle[]": "handles", "u32[]": "u32s", "f64[]": "f64s", upload: "upload", readback: "readback" };
const nativeOps = wireOps.map((op) => {
  const operands = [...(op.result ? [{ name: "handle", type: "handle" }] : []), ...op.args];
  for (const arg of operands) cxxIdentifier(arg.name, `${op.name} operand`);
  const request = op.args.some((arg) => arg.name === "requestId");
  const resource = request ? operands.find((arg) => arg.type === "handle")?.name : undefined;
  return { op, operands, request, resource, type: `${pascal(camel(op.name))}Op`, name: camel(op.name) };
});
const nativeConstant = (name, value) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail(`constant ${name} does not fit a native uint32_t`);
  return `inline constexpr uint32_t ${name} = ${value}u;`;
};
const nativeEnumName = (name) => `k${pascal(name)}`;
const nativeStruct = ({ op, operands, request, resource, type, name }) => [
  `// opcode ${op.code}${op.result ? `, result ${op.result}` : ""}${op.control ? ", control (runs after a rejection; its result is ignored then)" : ""}${op.completes ? `, request completing with ${op.completes}` : ""}`,
  `struct ${type} {`,
  `  static constexpr Opcode kOpcode = Opcode::${pascal(camel(op.name))};`,
  `  static constexpr const char* kName = ${cxxString(name)};`,
  `  static constexpr bool kControl = ${op.control ? "true" : "false"};`,
  `  static constexpr bool kRequest = ${request ? "true" : "false"};`,
  `  static constexpr Event kCompletes = ${op.completes ? `Event::${pascal(camel(op.completes))}` : "Event{}"};`,
  `  static constexpr const char* kResult = ${op.result ? cxxString(op.result) : "nullptr"};`,
  ...operands.map((arg) => `  ${cxxTypes[arg.type]} ${arg.name}{};`),
  `  uint32_t request_id() const noexcept { return ${request ? "requestId" : "0u"}; }`,
  `  Handle request_handle() const noexcept { return ${resource ?? "Handle{}"}; }`,
  `  template <class F> void visit_fields(F&& f) const {${operands.map((arg) => ` f(${cxxString(arg.name)}, ${arg.name});`).join("")}${operands.length ? " " : " (void)f; "}}`,
  "};",
].join("\n");
const nativeCase = ({ op, operands, type }) =>
  `      case ${op.code}: { ${type} op;${operands.map((arg) => ` op.${arg.name} = r.${cxxReaders[arg.type]}();`).join("")} if (!r.failed()) session.step(op, start); break; }`;
const recordStructs = Object.entries(spec.records).map(([name, fields]) => {
  fields.forEach((field) => { cxxIdentifier(field, `record ${name} field`); if (field === "name" || field === "width") fail(`record ${name} field ${field} is reserved natively`); });
  return `struct ${pascal(name)} {\n  static constexpr const char* kName = ${cxxString(name)};\n  static constexpr uint32_t kWidth = ${fields.length}u;\n  enum Field : uint32_t { ${fields.map((field, index) => `${nativeEnumName(field)} = ${index}`).join(", ")} };\n};`;
}).join("\n");
const recordFieldTables = Object.entries(spec.records).map(([name, fields]) =>
  `inline constexpr const char* const k${pascal(name)}Fields[] = { ${fields.map(cxxString).join(", ")} };`).join("\n");
const enumTables = Object.entries(spec.enums).map(([name, values]) =>
  `inline constexpr const char* const k${pascal(name)}[] = { ${values.map((value) => value === null ? "nullptr" : cxxString(value)).join(", ")} };`).join("\n");
const nativeDecodeErrors = Object.entries(decodeFailures);

const nativeHeader = `// generated from gpu/ops.json by gpu/generate.mjs — do not edit
//
// Portable C++17 decoder for the nativetron GPU command stream, protocol ${spec.version}, identity ${identityHex}.
// It has no WebGPU, platform or allocation dependency on the decode path; it is the native twin of the
// generated JS decodeGpuBatch in gpu-host.generated.js and follows the same wire and batch contract.
//
// Wire format: a batch starts with the ${headerBytes}-byte header (u8 opcode ${header.code}, u32 version, u32 identity),
// followed by operations: u8 opcode, then the operands of gpu/ops.json in order. Scalars are little-endian and
// unaligned (u32, i32, f32, f64 and handles are 4 or 8 bytes; bool is one byte that must be 0 or 1). str is a
// u32 byte length followed by that many bytes. handle[], u32[] and f64[] are a u32 element count (at most
// kMaxArrayLength) followed by the elements. upload and readback ranges are u32 offset, u32 length into the
// embedding's staging arenas. Operations that create a resource carry the guest-allocated result handle first.
//
// Usage:
//   struct Executor {
//     bool on(const nativetron::gpu::CreateBufferOp& op);      // one overload per operation (or a template)
//     ...
//     void on_skipped_request(const nativetron::gpu::SkippedRequest& skipped);
//     void on_error(const nativetron::gpu::ErrorReport& report);
//   };
//   nativetron::gpu::BatchResult result = nativetron::gpu::decode_batch(bytes, size, executor);
// Every operation struct must have an overload, so a schema change is a compile error in the executor. The
// abstract nativetron::gpu::Visitor declares the same members virtually; VisitorAdapter<T> erases a template
// visitor behind it. on() returns true when the executor accepted the operation and false when it rejected it.
// The decoder is exception-neutral and never catches: report a rejection by returning false.
//
// Batch contract (identical to the JS host):
// - Preflight: a batch larger than kMaxBatchBytes, shorter than the header, with another first opcode, or with a
//   different version or identity is refused before any operation (fatal ErrorReport, outcome Fatal).
// - Decoding and execution are interleaved and ordered, not transactional. An operation is delivered only
//   after all of its operands decoded; operations before a failure are never rolled back.
// - A malformed operation (truncation, unknown opcode, bool other than 0/1, array count above kMaxArrayLength)
//   stops the batch: on_error(fatal = true) with request id 0 and handle 0, outcome Fatal. Later bytes are not
//   inspected, so requests after that point are never seen and never cancelled; the reactor is out of protocol.
// - The first on() returning false is a host rejection: on_error(fatal = false) with that operation's request
//   id and request handle (both 0 unless the operation is a request; the handle is its first handle operand,
//   including the result handle), outcome Rejected. Decoding continues without executing: control operations
//   (${wireOps.filter((op) => op.control).map((op) => camel(op.name)).join(", ")}) are still delivered to on() and their result is ignored,
//   request operations are reported once each through on_skipped_request (complete them with their completion
//   event and status CANCELLED), every other operation is dropped. A later malformed operation is still fatal,
//   giving a second, fatal on_error.
//
// Guarantees: every operand delivered to on() is in bounds of the batch and of the declared type; bools are 0/1;
// arrays hold at most kMaxArrayLength elements; Str, arrays and ranges are views into the caller's batch bytes
// and are valid only until the batch memory is reused. Loads are byte-wise, so any alignment and host byte
// order are safe. The executor remains responsible for every semantic check the JS host performs: handle
// liveness, generation and kind (see handle_slot/handle_generation), result-handle reservation, request id
// validity (nonzero, not pending, at most kMaxPendingRequests; on_skipped_request and rejections can carry 0 or a
// pending id, which the JS host reports as duplicateRequestId instead of completing), enum indices (nullptr
// entries are invalid), record widths and counts, finite/integral f64 operands, upload/readback range bounds
// against the arenas (compute in 64 bits) and the readback lease, feature and limit negotiation, and WebGPU
// recording state. Str bytes are not validated as UTF-8: Str::text() decodes them exactly as the JS
// TextDecoder does (WHATWG UTF-8, replacement characters, leading BOM removed).
#ifndef NATIVETRON_GPU_NATIVE_DECODER_GENERATED_H
#define NATIVETRON_GPU_NATIVE_DECODER_GENERATED_H

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <string_view>

namespace nativetron::gpu {

static_assert(std::numeric_limits<float>::is_iec559 && sizeof(float) == 4, "IEEE-754 binary32 float required");
static_assert(std::numeric_limits<double>::is_iec559 && sizeof(double) == 8, "IEEE-754 binary64 double required");

inline constexpr uint32_t kProtocolVersion = ${spec.version}u;
inline constexpr uint32_t kProtocolIdentity = ${identityHex}u;
inline constexpr uint8_t kProtocolOpcode = ${header.code}u;
inline constexpr uint32_t kProtocolHeaderBytes = ${headerBytes}u;
inline constexpr uint32_t kMaxBatchBytes = ${spec.maxBatchBytes}u;
inline constexpr uint32_t kMaxUploadBytes = ${spec.maxUploadBytes}u;
inline constexpr uint32_t kMaxReadbackBytes = ${spec.maxReadbackBytes}u;
inline constexpr uint32_t kMaxArrayLength = ${spec.maxArrayLength}u;
inline constexpr uint32_t kMaxPendingRequests = ${spec.maxPendingRequests}u;
inline constexpr uint32_t kHandleSlotBits = ${spec.handle.slotBits}u;
inline constexpr uint32_t kHandleGenerationBits = ${spec.handle.generationBits}u;
inline constexpr uint32_t kHandleSlotMask = ${2 ** spec.handle.slotBits - 1}u;
inline constexpr uint32_t kHandleGenerationMask = ${2 ** spec.handle.generationBits - 1}u;
inline constexpr uint32_t kOperationCount = ${wireOps.length}u;

namespace constants {
${[...constants].map(([name, { value }]) => nativeConstant(name, value)).join("\n")}
}  // namespace constants

enum class Opcode : uint8_t {
${[...nativeOps.map(({ op }) => `  ${pascal(camel(op.name))} = ${op.code},`), `  ${pascal(camel(header.name))} = ${header.code},  // batch header only; unknown inside a batch`].join("\n")}
};

enum class Event : uint32_t {
${spec.events.map((event) => `  ${pascal(camel(event.name))} = ${event.code},${event.terminal ? "  // terminal" : ""}`).join("\n")}
};

enum class Status : uint32_t {
${spec.statuses.map((status) => `  ${pascal(camel(status.name))} = ${status.code},`).join("\n")}
};

inline const char* event_name(Event event) noexcept {
  switch (event) {
${spec.events.map((event) => `    case Event::${pascal(camel(event.name))}: return ${cxxString(event.name)};`).join("\n")}
  }
  return nullptr;
}

inline bool event_is_terminal(Event event) noexcept {
  switch (event) {
${spec.events.map((event) => `    case Event::${pascal(camel(event.name))}: return ${event.terminal ? "true" : "false"};`).join("\n")}
  }
  return false;
}

// Handles: ${spec.handle.slotBits}-bit slot, ${spec.handle.generationBits}-bit generation (generation << ${spec.handle.slotBits} | slot); 0 is "no handle".
enum class Handle : uint32_t {};
inline constexpr uint32_t handle_value(Handle handle) noexcept { return static_cast<uint32_t>(handle); }
inline constexpr uint32_t handle_slot(Handle handle) noexcept { return handle_value(handle) & kHandleSlotMask; }
inline constexpr uint32_t handle_generation(Handle handle) noexcept { return (handle_value(handle) >> kHandleSlotBits) & kHandleGenerationMask; }
inline constexpr Handle make_handle(uint32_t slot, uint32_t generation) noexcept {
  return static_cast<Handle>(((generation & kHandleGenerationMask) << kHandleSlotBits) | (slot & kHandleSlotMask));
}

namespace wire {
inline uint32_t load_u32(const uint8_t* p) noexcept {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
inline uint64_t load_u64(const uint8_t* p) noexcept {
  return static_cast<uint64_t>(load_u32(p)) | (static_cast<uint64_t>(load_u32(p + 4)) << 32);
}
inline int32_t load_i32(const uint8_t* p) noexcept { const uint32_t bits = load_u32(p); int32_t value; std::memcpy(&value, &bits, sizeof value); return value; }
inline float load_f32(const uint8_t* p) noexcept { const uint32_t bits = load_u32(p); float value; std::memcpy(&value, &bits, sizeof value); return value; }
inline double load_f64(const uint8_t* p) noexcept { const uint64_t bits = load_u64(p); double value; std::memcpy(&value, &bits, sizeof value); return value; }
inline void store_u32(uint8_t* p, uint32_t value) noexcept {
  p[0] = static_cast<uint8_t>(value); p[1] = static_cast<uint8_t>(value >> 8); p[2] = static_cast<uint8_t>(value >> 16); p[3] = static_cast<uint8_t>(value >> 24);
}

template <class T> struct Element;
template <> struct Element<uint32_t> { static constexpr size_t kBytes = 4; static uint32_t load(const uint8_t* p) noexcept { return load_u32(p); } };
template <> struct Element<Handle> { static constexpr size_t kBytes = 4; static Handle load(const uint8_t* p) noexcept { return static_cast<Handle>(load_u32(p)); } };
template <> struct Element<double> { static constexpr size_t kBytes = 8; static double load(const uint8_t* p) noexcept { return load_f64(p); } };

// WHATWG UTF-8 decode (TextDecoder("utf-8") with fatal false, ignoreBOM false). Returns true when the result
// equals the input bytes; out may be null to only check that.
inline bool decode_utf8(const uint8_t* bytes, size_t size, std::string* out) {
  bool same = true;
  size_t i = 0;
  if (size >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf) { i = 3; same = false; }
  if (out) out->reserve(size);
  uint32_t needed = 0, seen = 0;
  uint8_t lower = 0x80, upper = 0xbf;
  size_t lead = i;
  const auto replace = [&] { same = false; if (out) out->append("\\xef\\xbf\\xbd", 3); };
  while (i < size) {
    const uint8_t byte = bytes[i];
    if (needed == 0) {
      lead = i++;
      if (byte <= 0x7f) { if (out) out->push_back(static_cast<char>(byte)); }
      else if (byte >= 0xc2 && byte <= 0xdf) { needed = 1; }
      else if (byte >= 0xe0 && byte <= 0xef) { if (byte == 0xe0) lower = 0xa0; if (byte == 0xed) upper = 0x9f; needed = 2; }
      else if (byte >= 0xf0 && byte <= 0xf4) { if (byte == 0xf0) lower = 0x90; if (byte == 0xf4) upper = 0x8f; needed = 3; }
      else replace();
      continue;
    }
    if (byte < lower || byte > upper) {
      needed = seen = 0; lower = 0x80; upper = 0xbf;
      replace();
      continue;  // the byte is processed again as a lead byte
    }
    ++i; lower = 0x80; upper = 0xbf;
    if (++seen == needed) {
      if (out) out->append(reinterpret_cast<const char*>(bytes + lead), i - lead);
      needed = seen = 0;
    }
  }
  if (needed) replace();
  return same;
}
}  // namespace wire

// A str operand: borrowed bytes of the batch. bytes() is the raw wire value; text() is the exact string the JS
// host sees. is_exact_text() is true when bytes() already equals text(), so it can be used without a copy.
struct Str {
  const uint8_t* data = nullptr;
  uint32_t size = 0;
  std::string_view bytes() const noexcept { return size ? std::string_view(reinterpret_cast<const char*>(data), size) : std::string_view(); }
  bool is_exact_text() const { return wire::decode_utf8(data, size, nullptr); }
  std::string text() const { std::string out; wire::decode_utf8(data, size, &out); return out; }
};

// A handle[], u32[] or f64[] operand: borrowed little-endian elements of the batch; operator[] is unchecked.
template <class T> class WireArray {
 public:
  using value_type = T;
  static constexpr size_t kElementBytes = wire::Element<T>::kBytes;
  constexpr WireArray() noexcept = default;
  constexpr WireArray(const uint8_t* data, uint32_t count) noexcept : data_(data), count_(count) {}
  uint32_t size() const noexcept { return count_; }
  bool empty() const noexcept { return count_ == 0; }
  const uint8_t* data() const noexcept { return data_; }
  T operator[](uint32_t index) const noexcept { return wire::Element<T>::load(data_ + static_cast<size_t>(index) * kElementBytes); }

 private:
  const uint8_t* data_ = nullptr;
  uint32_t count_ = 0;
};
using HandleArray = WireArray<Handle>;
using U32Array = WireArray<uint32_t>;
using F64Array = WireArray<double>;

// upload and readback operands: offsets into the arenas passed with the batch, not validated by the decoder.
struct UploadRange { uint32_t offset = 0; uint32_t length = 0; };
struct ReadbackRange { uint32_t offset = 0; uint32_t length = 0; };
inline constexpr bool range_within(uint32_t offset, uint32_t length, uint64_t arena_bytes) noexcept {
  return static_cast<uint64_t>(offset) + length <= arena_bytes;
}

// Descriptor records: fixed-width groups of f64[] elements. The executor maps operands to record kinds and
// checks widths and counts exactly as the JS host does.
namespace record {
${recordStructs}
${recordFieldTables}
}  // namespace record

struct RecordInfo { const char* name; uint32_t width; const char* const* fields; };
inline constexpr RecordInfo kRecords[] = {
${Object.entries(spec.records).map(([name, fields]) => `  { ${cxxString(name)}, ${fields.length}u, record::k${pascal(name)}Fields },`).join("\n")}
};

template <class T> class RecordView {
 public:
  RecordView(WireArray<T> values, uint32_t width) noexcept : values_(values), width_(width) {}
  bool valid() const noexcept { return width_ != 0 && values_.size() % width_ == 0; }
  uint32_t count() const noexcept { return width_ ? values_.size() / width_ : 0; }
  T operator()(uint32_t index, uint32_t field) const noexcept { return values_[index * width_ + field]; }

 private:
  WireArray<T> values_;
  uint32_t width_;
};

// Enum tables: wire value = index; nullptr entries are not valid values.
namespace enums {
${enumTables}
}  // namespace enums

struct EnumInfo {
  const char* name; const char* const* values; uint32_t size;
  const char* at(uint32_t index) const noexcept { return index < size ? values[index] : nullptr; }
};
inline constexpr EnumInfo kEnums[] = {
${Object.entries(spec.enums).map(([name, values]) => `  { ${cxxString(name)}, enums::k${pascal(name)}, ${values.length}u },`).join("\n")}
};

// Feature bit i is (1 << i); limit ids are one-based (kLimits[0] is unused).
inline constexpr const char* const kFeatures[] = { ${spec.features.map(cxxString).join(", ")} };
enum class LimitClass : uint8_t { None, Maximum, Alignment };
struct LimitInfo { const char* name; LimitClass limit_class; };
inline constexpr LimitInfo kLimits[] = {
${spec.limits.map((limit) => limit ? `  { ${cxxString(limit.name)}, LimitClass::${pascal(limit.class)} },` : "  { nullptr, LimitClass::None },").join("\n")}
};

${nativeOps.map(nativeStruct).join("\n\n")}

struct OperationInfo { Opcode opcode; const char* name; bool control; bool request; Event completes; const char* result; };
inline const OperationInfo* operation_info(uint8_t opcode) noexcept {
  switch (opcode) {
${nativeOps.map(({ op, type }) => `    case ${op.code}: { static constexpr OperationInfo info{ ${type}::kOpcode, ${type}::kName, ${type}::kControl, ${type}::kRequest, ${type}::kCompletes, ${type}::kResult }; return &info; }`).join("\n")}
    default: return nullptr;
  }
}

enum class DecodeError : uint8_t {
  None = 0,
${nativeDecodeErrors.map(([name]) => `  ${pascal(name)},`).join("\n")}
};

// The same text as the JS host's fatal ERROR events.
inline const char* decode_error_message(DecodeError error) noexcept {
  switch (error) {
    case DecodeError::None: return nullptr;
${nativeDecodeErrors.map(([name, message]) => `    case DecodeError::${pascal(name)}: return ${cxxString(message)};`).join("\n")}
  }
  return nullptr;
}

// fatal: the batch stopped (error and message set, request_id 0, handle 0). Otherwise the executor rejected
// the operation at offset (error None, message nullptr; the executor supplies its own message).
struct ErrorReport {
  bool fatal = false;
  DecodeError error = DecodeError::None;
  const char* message = nullptr;
  uint8_t opcode = 0;  // operation being decoded or rejected; 0 for preflight failures
  uint32_t request_id = 0;
  Handle handle{};
  uint32_t offset = 0;  // byte offset of the operation's opcode, or of the failing operand
};

// A request operation that follows a rejection in the same batch: complete it with completion and CANCELLED.
struct SkippedRequest {
  Opcode opcode;
  uint32_t request_id;
  Event completion;
  Handle handle;
};

enum class BatchOutcome : uint8_t { Completed, Rejected, Fatal };
struct BatchResult {
  BatchOutcome outcome = BatchOutcome::Completed;
  DecodeError error = DecodeError::None;  // set when outcome is Fatal
  uint32_t error_offset = 0;
  uint32_t rejected_offset = 0;           // opcode offset of the rejected operation, when one was rejected
  bool rejected = false;
  uint32_t operations = 0;                // operations fully decoded (delivered, skipped or dropped)
  bool ok() const noexcept { return outcome == BatchOutcome::Completed; }  // the JS decoder's return value
};

inline size_t write_protocol_header(uint8_t* out) noexcept {
  out[0] = kProtocolOpcode;
  wire::store_u32(out + 1, kProtocolVersion);
  wire::store_u32(out + 5, kProtocolIdentity);
  return kProtocolHeaderBytes;
}

// Checks everything the JS host checks before the first operation.
inline DecodeError preflight_batch(const void* data, size_t size) noexcept {
  const auto* bytes = static_cast<const uint8_t*>(data);
  if (!bytes && size) return DecodeError::NotBytes;
  if (size > kMaxBatchBytes) return DecodeError::BatchLimit;
  if (size < kProtocolHeaderBytes || bytes[0] != kProtocolOpcode) return DecodeError::NoHeader;
  if (wire::load_u32(bytes + 1) != kProtocolVersion || wire::load_u32(bytes + 5) != kProtocolIdentity) return DecodeError::ProtocolMismatch;
  return DecodeError::None;
}

class Visitor {
 public:
  virtual ~Visitor() = default;
${nativeOps.map(({ type }) => `  virtual bool on(const ${type}& op) = 0;`).join("\n")}
  virtual void on_skipped_request(const SkippedRequest& skipped) = 0;
  virtual void on_error(const ErrorReport& report) = 0;

 protected:
  Visitor() = default;
  Visitor(const Visitor&) = default;
  Visitor& operator=(const Visitor&) = default;
};

template <class Impl> class VisitorAdapter final : public Visitor {
 public:
  explicit VisitorAdapter(Impl& impl) noexcept : impl_(impl) {}
${nativeOps.map(({ type }) => `  bool on(const ${type}& op) override { return impl_.on(op); }`).join("\n")}
  void on_skipped_request(const SkippedRequest& skipped) override { impl_.on_skipped_request(skipped); }
  void on_error(const ErrorReport& report) override { impl_.on_error(report); }

 private:
  Impl& impl_;
};

namespace detail {
class Reader {
 public:
  Reader(const uint8_t* bytes, size_t size, size_t offset) noexcept : bytes_(bytes), size_(size), offset_(offset) {}
  bool failed() const noexcept { return error_ != DecodeError::None; }
  bool at_end() const noexcept { return offset_ >= size_; }
  size_t offset() const noexcept { return offset_; }
  DecodeError error() const noexcept { return error_; }
  size_t error_offset() const noexcept { return error_offset_; }
  void fail(DecodeError error, size_t at) noexcept { if (!failed()) { error_ = error; error_offset_ = at; } }

  uint8_t u8() noexcept { if (!need(1)) return 0; return bytes_[offset_++]; }
  uint32_t u32() noexcept { if (!need(4)) return 0; const uint32_t value = wire::load_u32(bytes_ + offset_); offset_ += 4; return value; }
  int32_t i32() noexcept { if (!need(4)) return 0; const int32_t value = wire::load_i32(bytes_ + offset_); offset_ += 4; return value; }
  float f32() noexcept { if (!need(4)) return 0.0f; const float value = wire::load_f32(bytes_ + offset_); offset_ += 4; return value; }
  double f64() noexcept { if (!need(8)) return 0.0; const double value = wire::load_f64(bytes_ + offset_); offset_ += 8; return value; }
  Handle handle() noexcept { return static_cast<Handle>(u32()); }
  bool boolean() noexcept {
    const size_t at = offset_;
    const uint8_t value = u8();
    if (value > 1) fail(DecodeError::InvalidBoolean, at);
    return value == 1;
  }
  Str str() noexcept {
    const uint32_t length = u32();
    if (!need(length)) return {};
    Str value{bytes_ + offset_, length};
    offset_ += length;
    return value;
  }
  UploadRange upload() noexcept { UploadRange value; value.offset = u32(); value.length = u32(); return value; }
  ReadbackRange readback() noexcept { ReadbackRange value; value.offset = u32(); value.length = u32(); return value; }
  HandleArray handles() noexcept { return array<Handle>(); }
  U32Array u32s() noexcept { return array<uint32_t>(); }
  F64Array f64s() noexcept { return array<double>(); }

 private:
  bool need(size_t length) noexcept {
    if (failed()) return false;
    if (length > size_ - offset_) { fail(DecodeError::Truncated, offset_); return false; }
    return true;
  }
  template <class T> WireArray<T> array() noexcept {
    const size_t at = offset_;
    const uint32_t count = u32();
    if (failed()) return {};
    if (count > kMaxArrayLength) { fail(DecodeError::ArrayLimit, at); return {}; }
    if (!need(static_cast<size_t>(count) * WireArray<T>::kElementBytes)) return {};
    WireArray<T> value(bytes_ + offset_, count);
    offset_ += static_cast<size_t>(count) * WireArray<T>::kElementBytes;
    return value;
  }

  const uint8_t* bytes_;
  size_t size_;
  size_t offset_;
  DecodeError error_ = DecodeError::None;
  size_t error_offset_ = 0;
};

template <class V> struct Session {
  V& visitor;
  BatchResult& result;
  template <class Op> void step(const Op& op, size_t start) {
    ++result.operations;
    if (!result.rejected) {
      if (!visitor.on(op)) {
        result.rejected = true;
        result.rejected_offset = static_cast<uint32_t>(start);
        ErrorReport report;
        report.opcode = static_cast<uint8_t>(Op::kOpcode);
        report.request_id = op.request_id();
        report.handle = op.request_handle();
        report.offset = static_cast<uint32_t>(start);
        visitor.on_error(report);
      }
    } else if constexpr (Op::kControl) {
      (void)visitor.on(op);
    } else if constexpr (Op::kRequest) {
      visitor.on_skipped_request(SkippedRequest{Op::kOpcode, op.request_id(), Op::kCompletes, op.request_handle()});
    }
  }
};

template <class V> void report_fatal(V& visitor, BatchResult& result, DecodeError error, size_t offset, uint8_t opcode) {
  result.outcome = BatchOutcome::Fatal;
  result.error = error;
  result.error_offset = static_cast<uint32_t>(offset);
  ErrorReport report;
  report.fatal = true;
  report.error = error;
  report.message = decode_error_message(error);
  report.opcode = opcode;
  report.offset = static_cast<uint32_t>(offset);
  visitor.on_error(report);
}
}  // namespace detail

// Decodes one batch and drives the visitor; see the contract at the top of this file.
template <class V> BatchResult decode_batch(const void* data, size_t size, V& visitor) {
  BatchResult result;
  const DecodeError preflight = preflight_batch(data, size);
  if (preflight != DecodeError::None) { detail::report_fatal(visitor, result, preflight, 0, 0); return result; }
  detail::Reader r(static_cast<const uint8_t*>(data), size, kProtocolHeaderBytes);
  detail::Session<V> session{visitor, result};
  while (!r.at_end()) {
    const size_t start = r.offset();
    const uint8_t opcode = r.u8();
    switch (opcode) {
${nativeOps.map(nativeCase).join("\n")}
      default: r.fail(DecodeError::UnknownOpcode, start); break;
    }
    if (r.failed()) { detail::report_fatal(visitor, result, r.error(), r.error_offset(), opcode); return result; }
  }
  result.outcome = result.rejected ? BatchOutcome::Rejected : BatchOutcome::Completed;
  return result;
}

}  // namespace nativetron::gpu

#endif  // NATIVETRON_GPU_NATIVE_DECODER_GENERATED_H
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
  { path: join(here, "native-decoder.generated.h"), next: nativeHeader },
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
