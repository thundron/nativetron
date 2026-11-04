import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "keys.json"), "utf8"));
const check = process.argv.includes("--check");
let stale = 0;
for (const ts of [true, false]) {
  const type = (text) => ts ? `: ${text}` : "";
  const next = `// generated from commands/keys.json by commands/generate.mjs — do not edit
${ts ? "export interface Shortcut { key: string; modifiers: number; }\n" : ""}export const PALETTE_SHORTCUTS = ${JSON.stringify(spec.palette)};
export function parseShortcut(value${type("string")})${type("Shortcut")} {
  const parts = value.split("+");
  let modifiers = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    let bit = 0;
${Object.entries(spec.modifiers).map(([name, bit]) => `    if (part === ${JSON.stringify(name)}) bit = ${bit};`).join("\n")}
    if (!bit || (modifiers & bit)) throw new Error("invalid shortcut modifier: " + value);
    modifiers |= bit;
  }
  const key = parts[parts.length - 1]${ts ? "!" : ""};
  if (!/^[a-zA-Z0-9]$/.test(key) && !${JSON.stringify(spec.namedKeys)}.includes(key)) throw new Error("invalid shortcut key: " + value);
  return { key: key.toLowerCase(), modifiers };
}
`;
  const path = join(here, ts ? "keys.generated.ts" : "keys.generated.mjs");
  let previous = ""; try { previous = readFileSync(path, "utf8"); } catch {}
  if (previous === next) continue;
  stale++; if (check) console.error(`stale: ${path}`); else writeFileSync(path, next);
}
if (check && stale) process.exit(1);
console.log(check ? "commands: generated files up to date" : `commands: wrote ${stale} files`);
