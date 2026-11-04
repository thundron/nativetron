import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "..");
const spec = JSON.parse(readFileSync(join(here, "catalogue.json"), "utf8"));
const check = process.argv.includes("--check");

import { parseMessage } from "./message-parser.mjs";

const catalogue = JSON.parse(readFileSync(join(root, "locales/en.json"), "utf8"));
if (spec.version !== 1 || spec.locales.length !== 1 || spec.locales[0].tag !== "en" || spec.locales[0].pluralRule !== "english-cardinal") throw new Error("only the English cardinal catalogue is implemented");
let nextId = 0;
// Emit plural expressions as named functions so generated compiled code has no eval or runtime parser.
const helpers = [];
function render(nodes, plural = "") {
  return nodes.map((node) => {
    if (node.kind === "argument") return `argumentText(args, ${JSON.stringify(node.name)}, numericFormat)`;
    if (node.kind === "text") return !plural ? JSON.stringify(node.value) : node.value.split("#").map((part) => JSON.stringify(part)).join(` + numericFormat(${plural}) + `);
    const id = ++nextId, name = `plural${id}`, count = `count${id}`;
    const cases = node.cases.filter((entry) => entry.key !== "other").sort((a,b) => Number(b.key.startsWith("=")) - Number(a.key.startsWith("=")));
    const statements = cases.map((entry) => `  if (${entry.key.startsWith("=") ? `${count} === ${Number(entry.key.slice(1))}` : `Math.abs(${count}) === 1`}) return ${render(entry.body, count)};`);
    const fallback = render(node.cases.find((entry) => entry.key === "other").body, count);
    helpers.push(`function ${name}(args: MessageArg[], numericFormat: (value: number) => string): string {\n  const ${count} = numericArgument(args, ${JSON.stringify(node.name)});\n${statements.join("\n")}\n  return ${fallback};\n}`);
    return `${name}(args, numericFormat)`;
  }).join(" + ") || '""';
}
const keys = Object.keys(catalogue).sort();
const branches = keys.map((key) => {
  if (typeof catalogue[key] !== "string") throw new Error(`catalogue ${key} is not a string`);
  return `  if (key === ${JSON.stringify(key)}) return ${render(parseMessage(catalogue[key]))};`;
});
const walk = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "build") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (/\.(tsx?|jsx?|mjs)$/.test(entry.name) && !entry.name.includes("generated")) files.push(path);
  }
  return files;
};
const sourceArg = process.argv.indexOf("--source-dir");
const directories = sourceArg >= 0 ? [resolve(process.argv[sourceArg + 1])] : spec.sourceDirectories.map((directory) => join(root, directory));
for (const directory of directories) for (const file of walk(directory)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bmessage\(\s*["']([^"']+)["']/g)) if (!Object.hasOwn(catalogue, match[1])) throw new Error(`${file}: missing message key ${match[1]}`);
}
const outputs = [
  ["messages.generated.ts", `// generated from locales/en.json and i18n/catalogue.json — do not edit\nimport { argumentText, numericArgument, type MessageArg } from "./values.js";\n\n${helpers.join("\n\n")}\n\nexport function catalogueMessage(key: string, args: MessageArg[], numericFormat: (value: number) => string): string {\n${branches.join("\n")}\n  throw new Error("missing message key: " + key);\n}\n`],
  ["contract.generated.ts", `// generated from i18n/catalogue.json — do not edit\nexport const LOCALES = ${JSON.stringify(spec.locales.map((locale) => locale.tag))};\nexport const UNITS = ${JSON.stringify(spec.units)};\nexport const MAX_FORMATTED_BYTES = ${spec.maxFormattedBytes};\n`],
];
let stale = 0;
for (const [name, next] of outputs) {
  const path = join(here, name);
  let previous = ""; try { previous = readFileSync(path, "utf8"); } catch {}
  if (previous === next) continue;
  stale++;
  if (check) console.error(`stale: ${path}`); else writeFileSync(path, next);
}
if (check && stale) process.exit(1);
console.log(check ? "i18n: generated files up to date" : `i18n: wrote ${stale} files`);
