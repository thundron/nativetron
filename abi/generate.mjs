import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "ops.json"), "utf8"));
const check = process.argv.includes("--check");

const kind = (a) => (a.endsWith(":intern") ? "u32 intern id" : a.endsWith(":str") ? "length-prefixed utf-8" : "u32");
const bare = (a) => a.split(":")[0];

const table = [
  "| opcode | name | arguments |",
  "|---|---|---|",
  ...spec.ops.map((o) => `| ${o.code} | ${o.name} | ${o.args.map(bare).join(", ") || "—"} |`),
].join("\n");

const layout = spec.ops
  .map((o) => `    ${String(o.code).padStart(2)} ${o.name.padEnd(17)} ${o.args.map((a) => `${bare(a)}(${kind(a)})`).join(" ") || "—"}`)
  .join("\n");

const targets = [
  {
    path: join(here, "DOM_HOST_ABI.md"),
    render: (prev) =>
      prev.replace(/<!-- generated:ops -->[\s\S]*?<!-- \/generated:ops -->/,
        `<!-- generated:ops -->\n${table}\n\nWire layout:\n\n\`\`\`\n${layout}\n\`\`\`\n<!-- /generated:ops -->`),
  },
  {
    path: join(here, "..", "framework", "ops.generated.ts"),
    render: () =>
      "// generated from abi/ops.json by abi/generate.mjs — do not edit\n" +
      `export const ROOT_ID = ${spec.root};\n` +
      spec.ops.map((o) => `export const OP_${o.name} = ${o.code};`).join("\n") + "\n",
  },
];

let stale = 0;
for (const t of targets) {
  const prev = (() => { try { return readFileSync(t.path, "utf8"); } catch { return ""; } })();
  const next = t.render(prev);
  if (next === prev) continue;
  stale++;
  if (check) console.error(`stale: ${t.path}`);
  else writeFileSync(t.path, next);
}
if (check && stale) { console.error(`${stale} generated file(s) out of date — run: node abi/generate.mjs`); process.exit(1); }
console.log(check ? "abi: generated files up to date" : `abi: wrote ${stale} file(s)`);
