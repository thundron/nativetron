// Native decoder parity: gpu/native-decoder.generated.h against the generated JS decodeGpuBatch on shared
// wire fixtures (valid, rejected, malformed, truncated, oversized, UTF-8 and mutation fuzz).
// Needs a C++17 compiler (CXX, default c++); build outputs live in a temporary directory that is removed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as generated from "./gpu-host.generated.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "ops.json"), "utf8"));
const camel = (name) => name.toLowerCase().replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const parse = (arg) => { const at = arg.lastIndexOf(":"); return { name: arg.slice(0, at), type: arg.slice(at + 1) }; };
const wireOps = spec.ops.filter((op) => !op.header).map((op) => ({
  ...op, method: camel(op.name), operands: [...(op.result ? [{ name: "handle", type: "handle" }] : []), ...op.args.map(parse)],
}));
const byMethod = new Map(wireOps.map((op) => [op.method, op]));
const cxx = process.env.CXX ?? "c++";
const compiler = spawnSync(cxx, ["--version"], { encoding: "utf8" });
const skip = compiler.status === 0 ? false : `no C++ compiler (${cxx})`;

// Deterministic PRNG so fixtures and failures are reproducible.
function prng(seed) {
  return () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const fnv1a = (bytes) => { let hash = 0x811c9dc5; for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; } return hash.toString(16).padStart(8, "0"); };

// ---- encoding (raw values: numbers are written as bit patterns where noted, strings may be raw bytes) ----
const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; };
const header = (version = generated.GPU_PROTOCOL_VERSION, identity = generated.GPU_PROTOCOL_IDENTITY, opcode = generated.GPU_PROTOCOL_OPCODE) =>
  Buffer.concat([Buffer.from([opcode]), u32(version), u32(identity)]);
function encodeValue(type, value) {
  switch (type) {
    case "u32": case "i32": case "f32": case "handle": return u32(value);
    case "f64": return Buffer.from(value);
    case "bool": return Buffer.from([value]);
    case "str": return Buffer.concat([u32(value.length), value]);
    case "handle[]": case "u32[]": return Buffer.concat([u32(value.length), ...value.map(u32)]);
    case "f64[]": return Buffer.concat([u32(value.length), ...value.map((v) => Buffer.from(v))]);
    case "upload": case "readback": return Buffer.concat([u32(value[0]), u32(value[1])]);
  }
  throw new Error(`no encoder for ${type}`);
}
const encodeOp = (op, values) => Buffer.concat([Buffer.from([op.code]), ...op.operands.map((operand, i) => encodeValue(operand.type, values[i]))]);

const strings = [
  "", "main", "label with spaces", "çà ü 中文 😀", "\u{10ffff}\u{fffd}", "x".repeat(65), "y".repeat(300),
].map((text) => Buffer.from(text, "utf8")).concat([
  Buffer.from([0xef, 0xbb, 0xbf, 0x41]), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from([0x41, 0xef, 0xbb, 0xbf]),
  Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xc0, 0x80]), Buffer.from([0xe0, 0x80, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80]), Buffer.from([0xf0, 0x90, 0x41]),
  Buffer.from([0xe2, 0x82]), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xf0, 0x9f, 0x98]), Buffer.from([0xc2]), Buffer.from([0x80, 0xbf]),
]);
function randomBytes(random, length, high = 0.6) {
  const bytes = Buffer.alloc(length);
  const leads = [0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xc0, 0xc1, 0xff];
  for (let i = 0; i < length; i++) {
    const r = random();
    bytes[i] = r < 1 - high ? Math.floor(random() * 0x80) : r < 1 - high / 2 ? 0x80 + Math.floor(random() * 0x40) : leads[Math.floor(random() * leads.length)];
  }
  return bytes;
}
function randomValue(type, random) {
  const word = () => Math.floor(random() * 2 ** 32);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const f64 = () => {
    const b = Buffer.alloc(8);
    const r = random();
    if (r < 0.5) b.writeDoubleLE(pick([0, -0, 1, -1.5, 0.1, 1e300, -1e-300, 5e-324, 4096, Infinity, -Infinity, NaN, 2 ** 53 + 2, random() * 1e6]));
    else { b.writeUInt32LE(word(), 0); b.writeUInt32LE(r < 0.6 ? 0x7ff00000 + Math.floor(random() * 0x100000) : word(), 4); }
    return b;
  };
  switch (type) {
    case "u32": return random() < 0.5 ? pick([0, 1, 2, 4, 0x7fffffff, 0x80000000, 0xffffffff]) : word();
    case "i32": return random() < 0.5 ? pick([0, -1, 1, -0x80000000, 0x7fffffff]) >>> 0 : word();
    case "f32": return random() < 0.5 ? pick([0, 0x80000000, 0x3f800000, 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 0x00000001, 0xff7fffff]) : word();
    case "f64": return f64();
    case "bool": return random() < 0.5 ? 0 : 1;
    case "str": return random() < 0.7 ? pick(strings) : randomBytes(random, Math.floor(random() * 24));
    case "handle": return random() < 0.7 ? (1 + Math.floor(random() * 3)) * 2 ** 20 + Math.floor(random() * 64) : word();
    case "handle[]": case "u32[]": return Array.from({ length: random() < 0.1 ? 17 + Math.floor(random() * 40) : Math.floor(random() * 7) }, word);
    case "f64[]": return Array.from({ length: random() < 0.1 ? 17 + Math.floor(random() * 40) : Math.floor(random() * 11) }, f64);
    case "upload": case "readback": return [word(), random() < 0.5 ? Math.floor(random() * 1024) : word()];
  }
  throw new Error(type);
}
const randomOp = (op, random) => encodeOp(op, op.operands.map((operand) => randomValue(operand.type, random)));

// ---- JS reference: the generated decodeGpuBatch with a recording host double ----
const hexOf = (number) => {
  if (Number.isNaN(number)) return "nan";
  const b = Buffer.alloc(8); b.writeDoubleLE(number); return b.readBigUInt64LE().toString(16).padStart(16, "0");
};
function formatValue(type, value) {
  switch (type) {
    case "u32": case "i32": case "handle": return String(value);
    case "f32": case "f64": return hexOf(value);
    case "bool": return value ? "1" : "0";
    case "str": { const bytes = Buffer.from(value, "utf8"); return bytes.length <= 64 ? bytes.toString("hex") : `#${bytes.length}:${fnv1a(bytes)}`; }
    case "handle[]": case "u32[]": case "f64[]": {
      const joined = value.map((v) => formatValue(type === "f64[]" ? "f64" : "u32", v)).join(",");
      return value.length <= 16 ? `[${joined}]` : `[${value.length}#${fnv1a(Buffer.from(joined))}]`;
    }
    case "upload": case "readback": return `${value.offset}:${value.length}`;
  }
  throw new Error(type);
}
function jsTrace(bytes, rejects) {
  let trace = "", calls = 0;
  const target = {
    protocolError(error, requestId, handle, fatal) {
      trace += fatal ? `error fatal ${requestId} ${handle >>> 0} ${error.message}\n` : `error reject ${requestId} ${handle >>> 0}\n`;
    },
    skipRequest(requestId, type, handle) { trace += `skip ${requestId} ${type} ${handle >>> 0}\n`; },
  };
  const host = new Proxy(target, {
    get(object, name) {
      if (name in object) return object[name];
      const op = byMethod.get(name);
      if (!op) throw new Error(`decoder called unknown host method ${String(name)}`);
      return (...values) => {
        assert.equal(values.length, op.operands.length);
        trace += `call ${name}${op.operands.map((operand, i) => ` ${operand.name}=${formatValue(operand.type, values[i])}`).join("")}\n`;
        if (rejects.includes(calls++)) throw new Error("rejected by the test host");
      };
    },
  });
  const ok = generated.decodeGpuBatch(host, new Uint8Array(bytes));
  return `${trace}result ${ok ? 1 : 0}\n`;
}

// ---- fixtures ----
function fixtures() {
  const cases = [];
  const add = (name, bytes, rejects = []) => cases.push({ name, bytes, rejects });
  const random = prng(0x5eed);
  const fullBatch = (seed) => {
    const r = prng(seed);
    const ops = wireOps.map((op) => randomOp(op, r));
    for (let i = ops.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ops[i], ops[j]] = [ops[j], ops[i]]; }
    return Buffer.concat([header(), ...ops]);
  };

  for (const op of wireOps) for (let i = 0; i < 3; i++) add(`valid ${op.method} #${i}`, Buffer.concat([header(), randomOp(op, random)]));
  for (let seed = 1; seed <= 10; seed++) add(`all operations seed ${seed}`, fullBatch(seed));

  const base = fullBatch(42);
  for (let k = 0; k < wireOps.length; k++) add(`rejection at call ${k}`, base, [k]);
  for (let k = 0; k < wireOps.length; k += 7) add(`rejection at ${k} and every control after`, base, Array.from({ length: 200 }, (_v, i) => k + i));
  add("rejection then truncation", base.subarray(0, base.length - 3), [2]);
  // Request operations after a rejection are cancelled once each, controls still run.
  const tail = wireOps.filter((op) => op.completes || op.control);
  add("rejection before every request and control", Buffer.concat([header(), randomOp(byMethod.get("createBuffer"), random), ...tail.map((op) => randomOp(op, random))]), [0]);

  for (let length = 0; length < base.length; length++) add(`truncated to ${length}`, base.subarray(0, length));
  for (let length = 9; length < base.length; length += 13) add(`truncated to ${length} after rejection`, base.subarray(0, length), [0]);

  add("header only", header());
  add("wrong header opcode", header(undefined, undefined, 1));
  add("wrong version", header(generated.GPU_PROTOCOL_VERSION + 1));
  add("wrong identity", header(undefined, generated.GPU_PROTOCOL_IDENTITY ^ 1));
  add("wrong identity with operations", Buffer.concat([header(undefined, 0), randomOp(byMethod.get("requestFrame"), random)]));
  add("header opcode inside a batch", Buffer.concat([header(), header()]));
  const known = new Set(wireOps.map((op) => op.code));
  for (let code = 0; code < 256; code++) if (!known.has(code)) add(`unknown opcode ${code}`, Buffer.concat([header(), randomOp(byMethod.get("requestFrame"), random), Buffer.from([code, 1, 2, 3, 4])]));

  const createBuffer = byMethod.get("createBuffer");
  const sized = (total) => {
    const fixed = encodeOp(createBuffer, [2 ** 20 + 1, Buffer.alloc(8), 4, 0, Buffer.alloc(0)]).length;
    return Buffer.concat([header(), encodeOp(createBuffer, [2 ** 20 + 1, Buffer.alloc(8), 4, 0, Buffer.alloc(total - 9 - fixed, 0x61)])]);
  };
  add("exactly the batch limit", sized(generated.GPU_MAX_BATCH_BYTES));
  add("one byte over the batch limit", sized(generated.GPU_MAX_BATCH_BYTES + 1));
  for (const value of [2, 3, 0x80, 0xff]) {
    const bytes = Buffer.concat([header(), encodeOp(createBuffer, [2 ** 20 + 1, Buffer.alloc(8), 4, 0, Buffer.from("x")])]);
    bytes[9 + 1 + 4 + 8 + 4] = value;
    add(`invalid boolean ${value}`, bytes);
  }

  const setBindGroup = byMethod.get("renderSetBindGroup");
  const limit = generated.GPU_MAX_ARRAY_LENGTH;
  const words = Array.from({ length: limit }, (_v, i) => i * 2654435761);
  add("array at the element limit", Buffer.concat([header(), encodeOp(setBindGroup, [2 ** 20 + 1, 0, 2 ** 20 + 2, words])]));
  const over = Buffer.concat([header(), encodeOp(setBindGroup, [2 ** 20 + 1, 0, 2 ** 20 + 2, [1]])]);
  over.writeUInt32LE(limit + 1, over.length - 8);
  add("array count over the limit", over);
  const huge = Buffer.from(over); huge.writeUInt32LE(0xffffffff, huge.length - 8);
  add("array count 2^32-1", huge);
  const short = Buffer.from(over); short.writeUInt32LE(limit, short.length - 8);
  add("array at the limit but truncated", short);
  const stringLength = Buffer.concat([header(), encodeOp(createBuffer, [2 ** 20 + 1, Buffer.alloc(8), 4, 0, Buffer.from("abc")])]);
  stringLength.writeUInt32LE(0xffffffff, stringLength.length - 7);
  add("string length 2^32-1", stringLength);

  const utf = prng(0x7f8);
  for (let i = 0; i < 400; i++) {
    add(`utf8 fuzz ${i}`, Buffer.concat([header(), encodeOp(createBuffer, [2 ** 20 + 1, Buffer.alloc(8), 4, 0, randomBytes(utf, Math.floor(utf() * 40), 0.3 + utf() * 0.7)])]));
  }

  const mutate = prng(0xbad);
  for (let i = 0; i < 1500; i++) {
    const bytes = Buffer.from(fullBatch(100 + (i % 25)));
    const flips = 1 + Math.floor(mutate() * 4);
    for (let f = 0; f < flips; f++) {
      const at = mutate() < 0.05 ? Math.floor(mutate() * 9) : 9 + Math.floor(mutate() * (bytes.length - 9));
      bytes[at] = mutate() < 0.3 ? bytes[at] ^ (1 << Math.floor(mutate() * 8)) : Math.floor(mutate() * 256);
    }
    const cut = mutate() < 0.2 ? Math.floor(mutate() * bytes.length) : bytes.length;
    add(`mutation ${i}`, bytes.subarray(0, cut), mutate() < 0.3 ? [Math.floor(mutate() * 20)] : []);
  }
  return cases;
}

function writeFixtures(path, cases) {
  const chunks = [u32(0x4647544e), u32(cases.length)];
  for (const { bytes, rejects } of cases) chunks.push(u32(rejects.length), ...rejects.map(u32), u32(bytes.length), bytes);
  writeFileSync(path, Buffer.concat(chunks));
}

function jsMeta() {
  const lines = [];
  const head = new Uint8Array(generated.GPU_PROTOCOL_HEADER_BYTES);
  generated.writeGpuProtocolHeader(head);
  lines.push(`header ${Buffer.from(head).toString("hex")}`, "preflight 0");
  lines.push(`limits ${spec.maxBatchBytes} ${spec.maxUploadBytes} ${spec.maxReadbackBytes} ${spec.maxArrayLength} ${spec.maxPendingRequests} ${wireOps.length}`);
  const events = new Map(spec.events.map((event) => [event.name, event.code]));
  for (const op of [...wireOps].sort((a, b) => a.code - b.code)) {
    lines.push(`op ${op.code} ${op.method} ${op.control ? 1 : 0} ${op.completes ? 1 : 0} ${op.completes ? events.get(op.completes) : 0} ${op.result ?? "-"}`);
  }
  for (const event of spec.events) lines.push(`event ${event.code} ${event.name} ${event.terminal ? 1 : 0}`);
  for (const [name, values] of Object.entries(spec.enums)) lines.push(`enum ${name} ${[...values.map((value) => value ?? "-"), "-"].join(" ")}`);
  for (const [name, fields] of Object.entries(spec.records)) lines.push(`record ${name} ${fields.join(" ")}`);
  for (const feature of spec.features) lines.push(`feature ${feature}`);
  for (const limit of spec.limits) lines.push(`limit ${limit ? `${limit.name} ${limit.class === "maximum" ? 1 : 2}` : "- 0"}`);
  for (const message of ["GPU batch is not bytes", "GPU batch limit exceeded", "GPU batch has no protocol header", "GPU protocol version or identity mismatch",
    "truncated GPU batch", "invalid GPU boolean", "GPU array limit exceeded", "unknown GPU opcode"]) lines.push(`failure ${message}`);
  lines.push(`record-field ${spec.records.depthStencil.length} ${spec.records.depthStencil.indexOf("depthBiasClamp")} ${generated.RECORD_DEPTH_STENCIL_WIDTH}`);
  return lines.join("\n") + "\n";
}

test("the native decoder header is generated and up to date", () => {
  execFileSync(process.execPath, [join(here, "generate.mjs"), "--check"], { stdio: "pipe" });
  const text = readFileSync(join(here, "native-decoder.generated.h"), "utf8");
  assert.match(text, /^\/\/ generated from gpu\/ops\.json by gpu\/generate\.mjs — do not edit/);
  assert.ok(text.includes(`kProtocolIdentity = 0x${generated.GPU_PROTOCOL_IDENTITY.toString(16).padStart(8, "0")}u;`));
  // Standard library only: no WebGPU implementation or platform header.
  const includes = [...text.matchAll(/^#include\s+(\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(includes, ["<cstddef>", "<cstdint>", "<cstring>", "<limits>", "<string>", "<string_view>"]);
});

test("native decoder matches the JS decoder on shared wire fixtures", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nt-gpu-native-decoder-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, "native-decoder-test");
  const source = join(here, "native-decoder.test.cpp");
  const warnings = ["-std=c++17", "-Wall", "-Wextra", "-Wpedantic", "-Wshadow", "-Wconversion", "-Wsign-conversion", "-Werror", `-I${here}`];
  // Portability: the header and driver also build without exceptions and RTTI.
  execFileSync(cxx, [...warnings, "-fno-exceptions", "-fno-rtti", "-fsyntax-only", source], { stdio: "pipe" });
  const sanitizers = ["-fsanitize=address,undefined", "-fno-sanitize-recover=all"];
  const probe = spawnSync(cxx, [...warnings, "-O1", "-g", ...sanitizers, source, "-o", binary], { encoding: "utf8" });
  if (probe.status !== 0) execFileSync(cxx, [...warnings, "-O1", source, "-o", binary], { stdio: "pipe" });
  const run = (...args) => execFileSync(binary, args, { stdio: "pipe", env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } });

  run("meta", join(dir, "meta.txt"));
  assert.equal(readFileSync(join(dir, "meta.txt"), "utf8"), jsMeta());

  const cases = fixtures();
  writeFixtures(join(dir, "fixtures.bin"), cases);
  run("trace", join(dir, "fixtures.bin"), join(dir, "trace.txt"));
  const native = readFileSync(join(dir, "trace.txt"), "utf8").split(/^case \d+\n/m).slice(1);
  assert.equal(native.length, cases.length, "native trace case count");
  const outcomes = { ok: 0, rejected: 0, fatal: 0 };
  cases.forEach((fixture, index) => {
    const expected = jsTrace(fixture.bytes, fixture.rejects);
    if (native[index] !== expected) {
      const a = native[index].split("\n"), b = expected.split("\n");
      const line = a.findIndex((value, i) => value !== b[i]);
      assert.fail(`${fixture.name}: native/JS trace differs at line ${line}\n native: ${a[line]}\n js:     ${b[line]}`);
    }
    if (expected.includes("error fatal")) outcomes.fatal++;
    else if (expected.includes("error reject")) outcomes.rejected++;
    else outcomes.ok++;
  });
  // The fixture set must exercise every outcome.
  assert.ok(outcomes.ok > 100 && outcomes.rejected > 50 && outcomes.fatal > 1000, JSON.stringify(outcomes));
  t.diagnostic(`${cases.length} fixtures: ${JSON.stringify(outcomes)}; sanitizers ${probe.status === 0 ? "on" : "unavailable"}`);
});
