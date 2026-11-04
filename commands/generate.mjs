import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Usage: node commands/generate.mjs [--check] [--spec path/to/keys.json]
// The spec is validated with the generated parser itself, so the guest/host
// outputs and the JSON can never disagree about grammar or ownership.
const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes("--check");
const specArg = process.argv.indexOf("--spec");
const specPath = specArg >= 0 ? resolve(process.argv[specArg + 1] ?? "") : join(here, "keys.json");
const fail = (text) => { console.error(`commands: ${specPath}: ${text}`); process.exit(1); };
let spec;
try { spec = JSON.parse(readFileSync(specPath, "utf8")); } catch (error) { fail(`unreadable spec: ${error.message}`); }

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const allowed = ["modifiers", "namedKeys", "maxLength", "palette", "commandModifiers", "unmodifiedKeys", "reserved"];
if (!isObject(spec)) fail("spec must be an object");
for (const field of Object.keys(spec)) if (!allowed.includes(field)) fail(`unknown field ${field}`);
for (const field of allowed) if (!(field in spec)) fail(`missing field ${field}`);
if (!isObject(spec.modifiers) || Object.keys(spec.modifiers).length === 0) fail("modifiers must be a non-empty object");
const modifierNames = Object.keys(spec.modifiers), modifierBits = Object.values(spec.modifiers);
let modifierMask = 0;
for (let i = 0; i < modifierNames.length; i++) {
  const name = modifierNames[i], bit = modifierBits[i];
  if (!/^[A-Z][a-z]+$/.test(name)) fail(`invalid modifier name ${name}`);
  if (!Number.isInteger(bit) || bit <= 0 || bit > 128 || (bit & (bit - 1)) !== 0) fail(`modifier ${name} must be a single bit`);
  if (modifierMask & bit) fail(`modifier ${name} reuses bit ${bit}`);
  if (i > 0 && bit < modifierBits[i - 1]) fail("modifiers must be listed in ascending bit order (canonical order)");
  modifierMask |= bit;
}
if (!isStringList(spec.namedKeys)) fail("namedKeys must be a list of names");
for (const name of spec.namedKeys) {
  if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) fail(`invalid named key ${name}`);
  if (modifierNames.includes(name)) fail(`named key ${name} collides with a modifier`);
}
if (new Set(spec.namedKeys.map((name) => name.toLowerCase())).size !== spec.namedKeys.length) fail("namedKeys contain case-insensitive duplicates");
if (!Number.isInteger(spec.maxLength) || spec.maxLength < 8 || spec.maxLength > 256) fail("maxLength must be an integer in [8, 256]");
if (!isStringList(spec.palette) || spec.palette.length === 0) fail("palette must list at least one shortcut");
if (!isStringList(spec.commandModifiers) || spec.commandModifiers.length === 0) fail("commandModifiers must list modifiers");
let commandMask = 0;
for (const name of spec.commandModifiers) {
  if (!Object.hasOwn(spec.modifiers, name)) fail(`commandModifiers names unknown modifier ${name}`);
  commandMask |= spec.modifiers[name];
}
if (!Array.isArray(spec.unmodifiedKeys)) fail("unmodifiedKeys must be a list");
for (const name of spec.unmodifiedKeys) if (!spec.namedKeys.includes(name)) fail(`unmodifiedKeys names unknown key ${name}`);
if (!isObject(spec.reserved)) fail("reserved must map shortcuts to reasons");
for (const [shortcut, reason] of Object.entries(spec.reserved)) if (typeof reason !== "string" || !reason || /["\\\n]/.test(reason)) fail(`reserved ${shortcut} needs a plain reason`);

function render(ts, reserved) {
  const type = (text) => ts ? `: ${text}` : "";
  const bang = ts ? "!" : "";
  return `// generated from commands/keys.json by commands/generate.mjs — do not edit
${ts ? "export interface Shortcut { key: string; modifiers: number; }\n" : ""}export const MODIFIER_NAMES${type("string[]")} = ${JSON.stringify(modifierNames)};
export const MODIFIER_BITS${type("number[]")} = ${JSON.stringify(modifierBits)};
export const MODIFIER_MASK = ${modifierMask};
export const NAMED_KEYS${type("string[]")} = ${JSON.stringify(spec.namedKeys)};
export const SHORTCUT_MAX_LENGTH = ${spec.maxLength};
export const PALETTE_SHORTCUTS${type("string[]")} = ${JSON.stringify(spec.palette)};
export const COMMAND_MODIFIER_MASK = ${commandMask};
export const UNMODIFIED_KEYS${type("string[]")} = ${JSON.stringify(spec.unmodifiedKeys)};
export const RESERVED_SHORTCUTS${type("string[]")} = ${JSON.stringify(reserved.map((entry) => entry[0]))};
export const RESERVED_REASONS${type("string[]")} = ${JSON.stringify(reserved.map((entry) => entry[1]))};
/** Parse the bounded grammar: distinct modifiers, then one alphanumeric, named key or function key. */
export function parseShortcut(value${type("string")})${type("Shortcut")} {
  if (value.length > SHORTCUT_MAX_LENGTH) throw new Error("shortcut too long: " + value.slice(0, SHORTCUT_MAX_LENGTH));
  const parts = value.split("+");
  let modifiers = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    let bit = 0;
${modifierNames.map((name, i) => `    if (part === ${JSON.stringify(name)}) bit = ${modifierBits[i]};`).join("\n")}
    if (!bit || (modifiers & bit)) throw new Error("invalid shortcut modifier: " + value);
    modifiers |= bit;
  }
  const key = parts[parts.length - 1]${bang};
  if (!/^[a-zA-Z0-9]$/.test(key) && !NAMED_KEYS.includes(key)) throw new Error("invalid shortcut key: " + value);
  return { key: key.toLowerCase(), modifiers };
}
/** Canonical spelling of a parsed key: lower-case alphanumerics, catalogue spelling for named keys. */
export function keyName(key${type("string")})${type("string")} {
  for (let i = 0; i < NAMED_KEYS.length; i++) if (NAMED_KEYS[i]${bang}.toLowerCase() === key) return NAMED_KEYS[i]${bang};
  return key;
}
/** Canonical shortcut string: modifiers in bit order, then the canonical key. Equal shortcuts format identically. */
export function formatShortcut(shortcut${type("Shortcut")})${type("string")} {
  let out = "";
  for (let i = 0; i < MODIFIER_NAMES.length; i++) if (shortcut.modifiers & MODIFIER_BITS[i]${bang}) out += MODIFIER_NAMES[i]${bang} + "+";
  return out + keyName(shortcut.key);
}
export function canonicalShortcut(value${type("string")})${type("string")} { return formatShortcut(parseShortcut(value)); }
/** Index of a canonical shortcut in RESERVED_SHORTCUTS, or -1. */
export function reservedIndex(canonical${type("string")})${type("number")} {
  for (let i = 0; i < RESERVED_SHORTCUTS.length; i++) if (RESERVED_SHORTCUTS[i] === canonical) return i;
  return -1;
}
/** Empty when the shortcut may be owned by an application command, otherwise the refusal reason. */
export function commandShortcutError(value${type("string")})${type("string")} {
  const shortcut = parseShortcut(value), canonical = formatShortcut(shortcut);
  if ((shortcut.modifiers & COMMAND_MODIFIER_MASK) === 0 && !UNMODIFIED_KEYS.includes(keyName(shortcut.key))) return "command shortcut needs ${spec.commandModifiers.join(" or ")}: " + canonical;
  const reserved = reservedIndex(canonical);
  if (reserved >= 0) return "reserved shortcut " + canonical + " " + RESERVED_REASONS[reserved]${bang};
  for (let i = 0; i < PALETTE_SHORTCUTS.length; i++) if (canonicalShortcut(PALETTE_SHORTCUTS[i]${bang}) === canonical) return "shortcut " + canonical + " is owned by the command palette";
  return "";
}
/** Parse an application command shortcut, refusing text-editing, reserved and palette shortcuts. */
export function parseCommandShortcut(value${type("string")})${type("Shortcut")} {
  const error = commandShortcutError(value);
  if (error) throw new Error(error);
  return parseShortcut(value);
}
/**
 * Canonical shortcut for a keyboard event, or "" when the key is outside the grammar.
 * The layout-aware key wins; the physical code is the fallback when modifiers turn
 * a letter or digit into another character (Shift+1, Option+k, non-Latin layouts).
 */
export function eventShortcut(key${type("string")}, code${type("string")}, modifiers${type("number")})${type("string")} {
  if (modifiers < 0 || modifiers > MODIFIER_MASK || (modifiers | 0) !== modifiers || (modifiers & ~MODIFIER_MASK) !== 0) return "";
  let name = "";
  if (/^[a-zA-Z0-9]$/.test(key)) name = key.toLowerCase();
  else if (NAMED_KEYS.includes(key)) name = key.toLowerCase();
  else if (/^Key[A-Z]$/.test(code)) name = code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(code)) name = code.slice(5);
  else return "";
  return formatShortcut({ key: name, modifiers });
}
`;
}

// Validate the spec with the parser the spec generates (pass 1 has no reservations yet).
const probe = await import("data:text/javascript," + encodeURIComponent(render(false, [])));
const canonical = (value, where) => {
  try { return probe.canonicalShortcut(value); } catch (error) { fail(`${where}: ${error.message}`); }
};
const reserved = [], owners = new Map();
for (const [shortcut, reason] of Object.entries(spec.reserved)) {
  const name = canonical(shortcut, "reserved");
  if (owners.has(name)) fail(`reserved ${shortcut} duplicates ${owners.get(name)} after normalisation`);
  owners.set(name, `reserved ${shortcut}`);
  reserved.push([name, reason]);
}
for (const shortcut of spec.palette) {
  const name = canonical(shortcut, "palette");
  if (owners.has(name)) fail(`palette ${shortcut} duplicates ${owners.get(name)} after normalisation`);
  if ((probe.parseShortcut(shortcut).modifiers & commandMask) === 0) fail(`palette ${shortcut} needs ${spec.commandModifiers.join(" or ")} so it never steals typing`);
  owners.set(name, `palette ${shortcut}`);
}

let stale = 0;
for (const ts of [true, false]) {
  const next = render(ts, reserved);
  const path = join(here, ts ? "keys.generated.ts" : "keys.generated.mjs");
  let previous = ""; try { previous = readFileSync(path, "utf8"); } catch {}
  if (previous === next) continue;
  stale++; if (check) console.error(`stale: ${path}`); else writeFileSync(path, next);
}
if (check && stale) process.exit(1);
console.log(check ? "commands: generated files up to date" : `commands: wrote ${stale} files`);
