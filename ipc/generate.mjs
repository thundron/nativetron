import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "protocol.json"), "utf8"));
const check = process.argv.includes("--check");

const kind = (f) => (f.endsWith(":str") ? "u32 length + utf-8" : f.endsWith(":bytes") ? "u32 length + raw" : "u32");
const bare = (f) => f.split(":")[0];

const table = [
  "| kind | name | direction | fields |",
  "|---|---|---|---|",
  ...spec.kinds.map((k) => `| ${k.code} | ${k.name} | ${k.dir} | ${k.fields.map(bare).join(", ")} |`),
].join("\n");

const layout = spec.kinds
  .map((k) => `    ${String(k.code).padStart(2)} ${k.name.padEnd(8)} ${k.fields.map((f) => `${bare(f)}(${kind(f)})`).join(" ")}`)
  .join("\n");

const targets = [
  {
    path: join(here, "IPC.md"),
    render: (prev) =>
      prev.replace(/<!-- generated:kinds -->[\s\S]*?<!-- \/generated:kinds -->/,
        `<!-- generated:kinds -->\n${table}\n\nFrame: ${spec.header}. Maximum frame body: ${spec.maxFrameBytes} bytes.\n\n\`\`\`\n${layout}\n\`\`\`\n<!-- /generated:kinds -->`),
  },
  {
    path: join(here, "protocol.generated.ts"),
    render: () =>
      "// generated from ipc/protocol.json by ipc/generate.mjs — do not edit\n" +
      `export const IPC_VERSION = ${spec.version};\n` +
      `export const IPC_MAX_FRAME_SIZE = ${spec.maxFrameBytes};\n` +
      spec.kinds.map((k) => `export const FRAME_${k.name} = ${k.code};`).join("\n") + "\n",
  },
  {
    path: join(here, "protocol.generated.mjs"),
    render: () =>
      "// generated from ipc/protocol.json by ipc/generate.mjs — do not edit\n" +
      `export const IPC_VERSION = ${spec.version};\n` +
      `export const IPC_MAX_FRAME_SIZE = ${spec.maxFrameBytes};\n` +
      spec.kinds.map((k) => `export const FRAME_${k.name} = ${k.code};`).join("\n") + "\n",
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
if (check && stale) { console.error(`${stale} generated file(s) out of date — run: node ipc/generate.mjs`); process.exit(1); }
console.log(check ? "ipc: generated files up to date" : `ipc: wrote ${stale} file(s)`);
