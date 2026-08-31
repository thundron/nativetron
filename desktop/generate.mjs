import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const surface = JSON.parse(readFileSync(join(here, "surface.json"), "utf8"));
const allowed = new Set(["yes", "different", "no"]);

for (const row of surface.capabilities) {
  if (!allowed.has(row.status)) throw new Error(`invalid status for ${row.name}: ${row.status}`);
  if (row.status === "no") continue;
  if (!row.module) throw new Error(`${row.name}: implemented rows need a module`);
  const source = readFileSync(join(root, row.module), "utf8");
  if (row.contract === true) continue;
  const names = row.exports ?? [row.export];
  for (const name of names) {
    if (!name || !new RegExp(`export\\s+function\\s+${name}\\b`).test(source)) {
      throw new Error(`${row.name}: ${name ?? "missing export"} is not exported by ${row.module}`);
    }
  }
}

const count = (status) => surface.capabilities.filter((row) => row.status === status).length;
const cell = (value) => String(value ?? "").replaceAll("|", "\\|");
let out = `# Desktop compatibility\n\nPlatform: ${surface.platform}.\n\n`;
out += `${count("yes")} supported, ${count("different")} partial, ${count("no")} unsupported.\n\n`;
out += "| capability | status | note |\n|---|---|---|\n";
for (const row of surface.capabilities) {
  out += `| ${cell(row.name)} | ${row.status} | ${cell(row.note)} |\n`;
}
out += "\nGenerated from `desktop/surface.json`; do not edit directly.\n";

const path = join(here, "COMPATIBILITY.md");
if (process.argv.includes("--check")) {
  const current = readFileSync(path, "utf8");
  if (current !== out) {
    console.error("desktop: COMPATIBILITY.md out of date — run: node desktop/generate.mjs");
    process.exit(1);
  }
  console.log("desktop: up to date");
} else {
  writeFileSync(path, out);
  console.log(`desktop: wrote COMPATIBILITY.md (${surface.capabilities.length} rows)`);
}
