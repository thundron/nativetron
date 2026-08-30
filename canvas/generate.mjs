import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "ops.json"), "utf8"));
const check = process.argv.includes("--check");
const bare = (a) => a.split(":")[0];
const cls = (a) => (a.includes(":") ? a.split(":")[1] : "u32");

const camel = (n) => n.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const tsArgs = (o) => o.args.map((a) => `${bare(a)}: ${cls(a) === "str" || cls(a) === "intern" ? "string" : "number"}`).join(", ");
// iref emits its own INTERN op, so it must run BEFORE the opcode byte —
// otherwise the intern record lands inside this op's operands
const hoist = (o) =>
  o.args
    .filter((a) => cls(a) === "intern")
    .map((a) => `  const i_${bare(a)} = iref(${bare(a)});\n`)
    .join("");
const writes = (o) =>
  o.args
    .map((a) => (cls(a) === "f32" ? `f32(${bare(a)});` : cls(a) === "intern" ? `u32(i_${bare(a)});` : cls(a) === "str" ? `str(${bare(a)});` : `u32(${bare(a)});`))
    .join(" ");

const guest =
  "// generated from canvas/ops.json by canvas/generate.mjs — do not edit\n" +
  'import { f32, u32, str, iref, u8 } from "./encode.js";\n\n' +
  spec.ops
    .filter((o) => o.name !== "INTERN")
    .map((o) => `export function ${camel(o.name)}(${tsArgs(o)}): void {\n${hoist(o)}  u8(${o.code}); ${writes(o)}\n}`)
    .join("\n") + "\n";

const decode = spec.ops
  .filter((o) => o.name !== "INTERN")
  .map((o) => {
    const reads = o.args.map((a) => (cls(a) === "f32" ? "f32()" : cls(a) === "intern" ? "iv()" : cls(a) === "str" ? "s()" : "u32()"));
    const call = camel(o.name);
    const setter = { fillStyle: "fillStyle", strokeStyle: "strokeStyle", lineWidth: "lineWidth", font: "font", globalAlpha: "globalAlpha" };
    const prop = setter[call];
    const body = prop ? `c.${prop} = ${reads[0]};` : `c.${call}(${reads.join(", ")});`;
    return `      case ${o.code}: { ${body} break; }`;
  })
  .join("\n");

const host =
  "// generated from canvas/ops.json by canvas/generate.mjs — do not edit\n" +
  `(function () {
  var interned = [];
  window.__ntc = function (canvas, bytes) {
    var c = canvas.getContext("2d");
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var o = 0;
    var u32 = function () { var v = dv.getUint32(o, true); o += 4; return v; };
    var f32 = function () { var v = dv.getFloat32(o, true); o += 4; return v; };
    var s = function () { var n = u32(), r = ""; for (var q = o; q < o + n; q++) r += String.fromCharCode(bytes[q]); o += n; return r; };
    var iv = function () { return interned[u32()]; };
    while (o < bytes.byteLength) {
      var code = bytes[o++];
      switch (code) {
${decode}
        case 22: { var id = u32(); interned[id] = s(); break; }
      }
    }
  };
})();
`;

const targets = [
  { path: join(here, "canvas.generated.ts"), next: guest },
  { path: join(here, "canvas-host.generated.js"), next: host },
];
let stale = 0;
for (const t of targets) {
  const prev = (() => { try { return readFileSync(t.path, "utf8"); } catch { return ""; } })();
  if (t.next === prev) continue;
  stale++;
  if (check) console.error(`stale: ${t.path}`);
  else writeFileSync(t.path, t.next);
}
if (check && stale) { console.error(`${stale} canvas file(s) out of date — run: node canvas/generate.mjs`); process.exit(1); }
console.log(check ? "canvas: generated files up to date" : `canvas: wrote ${stale} file(s)`);
