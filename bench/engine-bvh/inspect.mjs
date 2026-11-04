// Read-only inspection of the emitted artifacts: f32 lowering in scriptc's LLVM IR and the Wasm memory/import surface.
// The .ll file is scriptc's emitted IR before LLVM's -O2 pipeline; the binary checks parse the actual reactor modules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lanes = { release: "./.scriptc", speed: "./.scriptc/speed" };
const count = (text, pattern) => (text.match(new RegExp(pattern, "g")) ?? []).length;
const fn = (llvm, pattern) => llvm.match(new RegExp(`^define internal [^\\n]*${pattern}[^]*?^}`, "m"))?.[0];

/**
 * Minimal dependency-free Wasm walk: memory limits (bit 1 = shared), memory imports, and an opcode census of every
 * function body. Decodes MVP, sign-extension, 0xFC (saturating truncation, bulk memory, tables) and reference-type
 * immediates; any 0xFD (SIMD128) or 0xFE (threads/atomics) prefix is counted and ends that body's scan.
 */
function wasmSurface(bytes) {
  let at = 8;
  const u = () => { let result = 0, shift = 0, byte; do { byte = bytes[at++]; result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80); return result; };
  const skipLeb = () => { while (bytes[at++] & 0x80); };
  assert.deepEqual([...bytes.subarray(0, 8)], [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  const memories = [], ops = { simd128: 0, atomics: 0, f32Arithmetic: 0, f32Compare: 0, f64Arithmetic: 0, f32Load: 0, f32Store: 0, demote: 0, promote: 0, saturatingTrunc: 0, bulkMemory: 0 };
  let functions = 0;
  while (at < bytes.length) {
    const id = bytes[at++], size = u(), end = at + size;
    if (id === 5) for (let n = u(); n > 0; n--) { const flags = u(), initial = u(), maximum = flags & 1 ? u() : null; memories.push({ flags, initialPages: initial, maximumPages: maximum, shared: (flags & 2) !== 0 }); }
    if (id === 10) {
      for (let n = u(); n > 0; n--, functions++) {
        const bodyEnd = u() + at;
        for (let groups = u(); groups > 0; groups--) { u(); at++; }
        scan: while (at < bodyEnd) {
          const op = bytes[at++];
          if (op === 0x02 || op === 0x03 || op === 0x04) { const t = bytes[at]; if (t === 0x40 || (t >= 0x6f && t <= 0x7f)) at++; else skipLeb(); }
          else if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x26) || op === 0xd2 || op === 0x12) skipLeb();
          else if (op === 0x0e) { for (let k = u(); k >= 0; k--) skipLeb(); }
          else if (op === 0x11 || op === 0x13) { skipLeb(); skipLeb(); }
          else if (op === 0x1c) { for (let k = u(); k > 0; k--) at++; }
          else if (op >= 0x28 && op <= 0x3e) { skipLeb(); skipLeb(); if (op === 0x2a) ops.f32Load++; if (op === 0x38) ops.f32Store++; }
          else if (op === 0x3f || op === 0x40 || op === 0xd0) at++;
          else if (op === 0x41 || op === 0x42) skipLeb();
          else if (op === 0x43) at += 4;
          else if (op === 0x44) at += 8;
          else if (op === 0xfc) {
            const sub = u();
            if (sub <= 7) ops.saturatingTrunc++;
            else if (sub === 8) { skipLeb(); at++; ops.bulkMemory++; }
            else if (sub === 10) { at += 2; ops.bulkMemory++; }
            else if (sub === 11) { at++; ops.bulkMemory++; }
            else if (sub === 9 || sub === 13 || (sub >= 15 && sub <= 17)) skipLeb();
            else if (sub === 12 || sub === 14) { skipLeb(); skipLeb(); }
            else throw new Error(`unknown 0xFC opcode ${sub}`);
          } else if (op === 0xfd || op === 0xfe) { if (op === 0xfd) ops.simd128++; else ops.atomics++; at = bodyEnd; break scan; }
          else if (op >= 0x5b && op <= 0x60) ops.f32Compare++;
          else if (op >= 0x8b && op <= 0x98) ops.f32Arithmetic++;
          else if (op >= 0x99 && op <= 0xa6) ops.f64Arithmetic++;
          else if (op === 0xb6) ops.demote++;
          else if (op === 0xbb) ops.promote++;
          else if (!(op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b || (op >= 0x45 && op <= 0xc4) || op === 0xd1)) throw new Error(`unknown opcode 0x${op.toString(16)}`);
        }
        assert.equal(at, bodyEnd, "function body decode drifted");
      }
    }
    at = end;
  }
  const module = new WebAssembly.Module(bytes);
  return { functions, opcodes: ops, memories, imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}:${i.kind}`), memoryImports: WebAssembly.Module.imports(module).filter((i) => i.kind === "memory").length };
}

const report = {};
for (const [lane, dir] of Object.entries(lanes)) {
  const llvm = readFileSync(new URL(`${dir}/workload.lib.ll`, import.meta.url), "utf8");
  const probe = fn(llvm, "@sc_f_f32Probe\\(");
  assert.ok(probe, "f32 probe was not emitted");
  for (const pattern of [/load float/, /fpext float/, /fmul double/, /fadd double/, /fptrunc double/]) assert.match(probe, pattern);
  // The two buildBinary bodies: the Float64 original and the Float32 substitution.
  const builders = [...llvm.matchAll(/^define internal ptr @sc_bf_[^\n]*_buildBinary\([^]*?^}/gm)].map((m) => m[0]);
  assert.equal(builders.length, 2, "expected the Float64 and Float32 buildBinary bodies");
  const stats = builders.map((body) => ({
    floatLoads: count(body, "load float"), fpext: count(body, "fpext float"), fptrunc: count(body, "fptrunc double"),
    floatArithmetic: count(body, "\\b(fadd|fsub|fmul|fdiv) float"), doubleArithmetic: count(body, "\\b(fadd|fsub|fmul|fdiv) double"),
    vectorTypes: count(body, "<\\d+ x (float|double|i32)>"),
  }));
  const [f32Builder] = stats.filter((s) => s.floatLoads > 0);
  assert.ok(f32Builder && f32Builder.fpext === f32Builder.floatLoads && f32Builder.floatArithmetic === 0, "Float32Array loads should widen to f64 arithmetic");
  assert.ok(stats.every((s) => s.vectorTypes === 0), "no vector IR expected");
  const surface = wasmSurface(readFileSync(new URL(`${dir}/workload.wasm`, import.meta.url)));
  assert.ok(surface.memories.length === 1 && !surface.memories[0].shared && surface.memoryImports === 0, "expected one defined, unshared memory");
  assert.equal(surface.opcodes.simd128, 0, "unexpected SIMD128 instructions"); assert.equal(surface.opcodes.atomics, 0, "unexpected atomics");
  report[lane] = { f32ProbeInstructions: probe.split("\n").filter((line) => /load float|fpext|fptrunc|fmul|fadd/.test(line)).map((line) => line.trim()), buildBinaryIr: stats, ...surface };
}
// f32 probes: the same expression with one final rounding versus Math.fround after every operation.
const js = await import("./f32-probe.ts");
js.fill(1024);
for (const [kernel, dir] of [["wide", "./.scriptc/f32-wide"], ["perOp", "./.scriptc/f32-perop"]]) {
  const bytes = readFileSync(new URL(`${dir}/f32-probe.wasm`, import.meta.url));
  const { instantiateFromBytes } = await import(`${dir}/f32-probe.mjs`);
  const api = await instantiateFromBytes(bytes, {});
  api.f32p_fill(1024);
  assert.equal(api[`f32p_${kernel}`](1024), js[kernel](1024), `${kernel}: wasm result differs from V8`);
  const { opcodes } = wasmSurface(bytes);
  report[`f32-probe ${kernel}`] = { sameResultAsV8: true, opcodes };
}
console.log(JSON.stringify(report, null, 2));
