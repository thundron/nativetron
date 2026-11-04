// Validates i18n/catalogue.json and the locale catalogues, statically checks message-key uses, and emits
// the compiled message functions plus host/native contracts. `--check` fails when an output is stale.
//
//   node i18n/generate.mjs [--check] [--source-dir DIR]... [--allow-dynamic FILE]... [--spec FILE --out-dir DIR]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseMessage, messageArguments } from "./message-parser.mjs";
import { compilePluralRule, conditionExpression } from "./plural-rules.mjs";
import { listSourceFiles, scanSources } from "./source-scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..");

// ECMA-402 sanctioned single unit identifiers; compound `-per-` units are not accepted by this module.
const SANCTIONED_UNITS = new Set(["acre", "bit", "byte", "celsius", "centimeter", "day", "degree", "fahrenheit", "fluid-ounce", "foot", "gallon", "gigabit", "gigabyte", "gram", "hectare", "hour", "inch", "kilobit", "kilobyte", "kilogram", "kilometer", "liter", "megabit", "megabyte", "meter", "microsecond", "mile", "mile-scandinavian", "milliliter", "millimeter", "millisecond", "minute", "month", "nanosecond", "ounce", "percent", "petabyte", "pound", "second", "stone", "terabit", "terabyte", "week", "yard", "year"]);
const TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;
const IDENT = /^[A-Za-z][A-Za-z0-9-]*$/;

const array = (value, what) => { if (!Array.isArray(value)) throw new Error(`catalogue.json: ${what} must be an array`); return value; };
const integer = (value, what, low, high) => { if (!Number.isInteger(value) || value < low || value > high) throw new Error(`catalogue.json: ${what} must be an integer in ${low}..${high}`); return value; };

export function loadSpec(specPath) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const known = new Set(["version", "sourceLocale", "locales", "pluralRules", "pluralFractionDigits", "units", "maxFormattedBytes", "sourceDirectories", "keyProperties", "dynamicKeyFiles"]);
  for (const key of Object.keys(spec)) if (!known.has(key)) throw new Error(`catalogue.json: unknown field ${key}`);
  if (spec.version !== 2) throw new Error("catalogue.json: version must be 2");
  const rules = new Map();
  for (const [name, table] of Object.entries(spec.pluralRules ?? {})) {
    if (!IDENT.test(name)) throw new Error(`catalogue.json: invalid plural rule name ${name}`);
    rules.set(name, compilePluralRule(name, table));
  }
  const tags = new Set();
  for (const locale of array(spec.locales, "locales")) {
    if (!TAG.test(locale.tag ?? "")) throw new Error(`catalogue.json: unsupported locale tag ${JSON.stringify(locale.tag)}`);
    if (tags.has(locale.tag)) throw new Error(`catalogue.json: duplicate locale ${locale.tag}`);
    tags.add(locale.tag);
    if (!rules.has(locale.pluralRule)) throw new Error(`catalogue.json: locale ${locale.tag} names undefined plural rule ${JSON.stringify(locale.pluralRule)}`);
    if (typeof locale.catalogue !== "string") throw new Error(`catalogue.json: locale ${locale.tag} needs a catalogue path`);
  }
  if (!tags.size) throw new Error("catalogue.json: at least one locale is required");
  if (!tags.has(spec.sourceLocale)) throw new Error("catalogue.json: sourceLocale must be one of locales");
  integer(spec.pluralFractionDigits, "pluralFractionDigits", 0, 15);
  integer(spec.maxFormattedBytes, "maxFormattedBytes", 16, 4096);
  for (const unit of array(spec.units, "units")) if (!SANCTIONED_UNITS.has(unit)) throw new Error(`catalogue.json: ${JSON.stringify(unit)} is not a sanctioned single unit`);
  if (new Set(spec.units).size !== spec.units.length) throw new Error("catalogue.json: duplicate unit");
  for (const field of ["sourceDirectories", "keyProperties", "dynamicKeyFiles"]) for (const value of array(spec[field] ?? [], field)) if (typeof value !== "string" || !value) throw new Error(`catalogue.json: ${field} entries must be strings`);
  return { ...spec, keyProperties: spec.keyProperties ?? [], dynamicKeyFiles: spec.dynamicKeyFiles ?? [], rules };
}

// Parses every catalogue and enforces cross-locale consistency: identical key sets and argument names.
export function loadCatalogues(spec, base) {
  const locales = spec.locales.map((locale) => {
    const path = resolve(base, locale.catalogue);
    const source = JSON.parse(readFileSync(path, "utf8"));
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`${locale.catalogue}: catalogue must be an object`);
    const rule = spec.rules.get(locale.pluralRule);
    const messages = new Map();
    for (const [key, text] of Object.entries(source)) {
      if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(key)) throw new Error(`${locale.catalogue}: invalid message key ${JSON.stringify(key)}`);
      if (typeof text !== "string") throw new Error(`${locale.catalogue}: ${key} is not a string`);
      try { messages.set(key, parseMessage(text, rule.categories)); }
      catch (error) { throw new Error(`${locale.catalogue}: ${key}: ${error.message}`); }
    }
    return { tag: locale.tag, file: locale.catalogue, rule, messages };
  });
  const source = locales.find((locale) => locale.tag === spec.sourceLocale);
  const keys = new Set(source.messages.keys());
  const signatures = new Map();
  for (const key of keys) signatures.set(key, messageArguments(source.messages.get(key)));
  const problems = [];
  for (const locale of locales) {
    for (const key of keys) if (!locale.messages.has(key)) problems.push(`${locale.file}: missing translation for ${key}`);
    for (const key of locale.messages.keys()) {
      if (!keys.has(key)) { problems.push(`${locale.file}: ${key} is not in the source catalogue ${source.file}`); continue; }
      const theirs = messageArguments(locale.messages.get(key)), ours = signatures.get(key);
      const names = (map) => [...map.keys()].sort().join(",");
      if (names(theirs) !== names(ours)) problems.push(`${locale.file}: ${key} uses arguments {${names(theirs)}} but ${source.file} uses {${names(ours)}}`);
      for (const [name, kind] of theirs) if (kind === "number") ours.set(name, "number");
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return { locales, keys: new Set([...keys].sort()), signatures };
}

const ident = (text) => text.replace(/[^A-Za-z0-9]/g, "_");

export function renderOutputs(spec, catalogues) {
  const digits = spec.pluralFractionDigits;
  const usedRules = [...new Set(catalogues.locales.map((locale) => locale.rule.name))].map((name) => spec.rules.get(name));
  const ruleFunctions = usedRules.map((rule) => {
    const lines = [];
    for (const entry of rule.entries) {
      const condition = conditionExpression(entry.condition);
      if (condition === "false") continue;
      lines.push(condition === "true" ? `  return ${JSON.stringify(entry.category)};` : `  if (${condition}) return ${JSON.stringify(entry.category)};`);
      if (condition === "true") break;
    }
    return `function rule_${ident(rule.name)}(o: PluralOperands): string {\n${lines.join("\n")}${lines.length ? "\n" : ""}${lines.at(-1)?.startsWith("  return") ? "" : '  return "other";\n'}}`;
  });
  const helpers = [];
  const localeFunctions = catalogues.locales.map((locale) => {
    let nextId = 0;
    const prefix = ident(locale.tag);
    const render = (nodes, count = "") => nodes.map((node) => {
      if (node.kind === "argument") return `argumentText(args, ${JSON.stringify(node.name)}, numericFormat)`;
      if (node.kind === "text") return !count ? JSON.stringify(node.value) : node.value.split("#").map((part) => JSON.stringify(part)).join(` + numericFormat(${count}) + `);
      const id = ++nextId, name = `${prefix}_plural${id}`, variable = `count${id}`;
      const exact = node.cases.filter((entry) => entry.exact !== null).map((entry) => `  if (${variable} === ${entry.exact}) return ${render(entry.body, variable)};`);
      const categorical = node.cases.filter((entry) => entry.exact === null && entry.key !== "other");
      const lines = [...exact];
      if (categorical.length) {
        lines.push(`  const category${id} = rule_${ident(locale.rule.name)}(pluralOperands(${variable}, ${digits}));`);
        for (const entry of categorical) lines.push(`  if (category${id} === ${JSON.stringify(entry.key)}) return ${render(entry.body, variable)};`);
      }
      const other = render(node.cases.find((entry) => entry.key === "other").body, variable);
      helpers.push(`function ${name}(args: MessageArg[], numericFormat: NumericFormat): string {\n  const ${variable} = numericArgument(args, ${JSON.stringify(node.name)});\n${lines.join("\n")}${lines.length ? "\n" : ""}  return ${other};\n}`);
      return `${name}(args, numericFormat)`;
    }).join(" + ") || '""';
    const branches = [...catalogues.keys].map((key) => `  if (key === ${JSON.stringify(key)}) return ${render(locale.messages.get(key))};`);
    return `function messages_${prefix}(key: string, args: MessageArg[], numericFormat: NumericFormat): string {\n${branches.join("\n")}\n  throw new Error("missing message key: " + key);\n}`;
  });
  const dispatch = (call) => catalogues.locales.map((locale) => `  if (locale === ${JSON.stringify(locale.tag)}) return ${call(locale)};`).join("\n");
  const keys = [...catalogues.keys];
  const tags = spec.locales.map((locale) => locale.tag);
  const messages = `// generated from i18n/catalogue.json and its locale catalogues by i18n/generate.mjs — do not edit
import { argumentText, numericArgument, type MessageArg } from "./values.js";
import { ${ruleFunctions.some((text) => text.includes("digitsMod(")) ? "digitsMod, " : ""}pluralOperands, type PluralOperands } from "./plural.js";

type NumericFormat = (value: number) => string;

${ruleFunctions.join("\n\n")}

export function pluralCategory(locale: string, value: number): string {
${dispatch((locale) => `rule_${ident(locale.rule.name)}(pluralOperands(value, ${digits}))`)}
  throw new Error("unsupported locale: " + locale);
}

${helpers.join("\n\n")}

${localeFunctions.join("\n\n")}

export function catalogueHas(key: string): boolean {
${keys.map((key) => `  if (key === ${JSON.stringify(key)}) return true;`).join("\n")}
  return false;
}

export function catalogueMessage(locale: string, key: string, args: MessageArg[], numericFormat: NumericFormat): string {
${dispatch((locale) => `messages_${ident(locale.tag)}(key, args, numericFormat)`)}
  throw new Error("unsupported locale: " + locale);
}
`;
  const constants = [
    ["LOCALES", tags], ["SOURCE_LOCALE", spec.sourceLocale], ["UNITS", spec.units], ["MAX_FORMATTED_BYTES", spec.maxFormattedBytes],
    ["PLURAL_FRACTION_DIGITS", digits], ["MESSAGE_KEYS", keys],
  ];
  const contract = `// generated from i18n/catalogue.json by i18n/generate.mjs — do not edit\n${constants.map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join("\n")}\n`;
  const categories = Object.fromEntries(catalogues.locales.map((locale) => [locale.tag, locale.rule.categories]));
  const hostContract = `${contract}export const PLURAL_CATEGORIES = ${JSON.stringify(categories)};\n`;
  const header = `// generated from i18n/catalogue.json by i18n/generate.mjs — do not edit
// Native/static-library adapter for the i18n pull formatting contract (see i18n/README.md).
// Bind the profile callbacks
//   localeFormatBegin: params [f64, string, string, f64, f64] returns f64
//   localeFormatByte:  params [f64] returns f64
// to nt_i18n_format_begin / nt_i18n_format_byte with a nt_i18n_format_state * as userdata, and pass
// both bindings to pullLocaleFormatter(...). Callbacks are synchronous on the owning thread and copy
// the borrowed locale/unit strings before returning; they never call back into the library.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#ifdef __cplusplus
extern "C" {
#endif
#define NT_I18N_MAX_FORMATTED_BYTES ${spec.maxFormattedBytes}
#define NT_I18N_FORMAT_OVERFLOW (-1)
#define NT_I18N_FORMAT_UNSUPPORTED (-2)
#define NT_I18N_LOCALE_COUNT ${tags.length}
#define NT_I18N_UNIT_COUNT ${spec.units.length}
static const char *const nt_i18n_locales[NT_I18N_LOCALE_COUNT] = { ${tags.map((tag) => JSON.stringify(tag)).join(", ")} };
static const char *const nt_i18n_units[NT_I18N_UNIT_COUNT] = { ${spec.units.map((unit) => JSON.stringify(unit)).join(", ")} };

// Platform formatter: write at most capacity UTF-8 bytes of value formatted for locale (unit is empty for
// a plain number) with 0..maximum_fraction_digits fraction digits, grouping on, standard notation, short
// unit display. Return the byte count, NT_I18N_FORMAT_OVERFLOW, or NT_I18N_FORMAT_UNSUPPORTED.
// locale and unit are NUL-terminated copies valid only during the call.
typedef int32_t (*nt_i18n_platform_format)(void *context, double value, const char *locale, const char *unit, int32_t maximum_fraction_digits, uint8_t *output, size_t capacity);

typedef struct nt_i18n_format_state {
  nt_i18n_platform_format format;
  void *context;
  int32_t length; // staged bytes, or -1 when nothing is staged
  uint8_t bytes[NT_I18N_MAX_FORMATTED_BYTES];
} nt_i18n_format_state;

static inline void nt_i18n_format_state_init(nt_i18n_format_state *state, nt_i18n_platform_format format, void *context) {
  state->format = format; state->context = context; state->length = -1;
}

static inline int nt_i18n_copy_token(char *target, size_t capacity, const uint8_t *bytes, size_t length) {
  if (length >= capacity || (length && !bytes)) return 0;
  for (size_t i = 0; i < length; i++) if (bytes[i] == 0) return 0;
  if (length) memcpy(target, bytes, length);
  target[length] = 0;
  return 1;
}

static inline int nt_i18n_listed(const char *const *values, size_t count, const char *value) {
  for (size_t i = 0; i < count; i++) if (strcmp(values[i], value) == 0) return 1;
  return 0;
}

static inline double nt_i18n_format_begin(void *userdata, double value, const uint8_t *locale, size_t locale_length, const uint8_t *unit, size_t unit_length, double digits, double capacity) {
  nt_i18n_format_state *state = (nt_i18n_format_state *)userdata;
  char locale_text[36], unit_text[36];
  state->length = -1;
  if (!state->format || !(value == value) || value - value != 0) return NT_I18N_FORMAT_UNSUPPORTED;
  if (!(digits >= 0 && digits <= 20 && digits == (double)(int32_t)digits)) return NT_I18N_FORMAT_UNSUPPORTED;
  if (!(capacity >= 0 && capacity <= 1048576 && capacity == (double)(size_t)capacity)) return NT_I18N_FORMAT_UNSUPPORTED;
  if (!nt_i18n_copy_token(locale_text, sizeof locale_text, locale, locale_length) || !nt_i18n_copy_token(unit_text, sizeof unit_text, unit, unit_length)) return NT_I18N_FORMAT_UNSUPPORTED;
  if (!nt_i18n_listed(nt_i18n_locales, NT_I18N_LOCALE_COUNT, locale_text) || (unit_text[0] && !nt_i18n_listed(nt_i18n_units, NT_I18N_UNIT_COUNT, unit_text))) return NT_I18N_FORMAT_UNSUPPORTED;
  size_t limit = (size_t)capacity < NT_I18N_MAX_FORMATTED_BYTES ? (size_t)capacity : NT_I18N_MAX_FORMATTED_BYTES;
  int32_t length = state->format(state->context, value, locale_text, unit_text, (int32_t)digits, state->bytes, limit);
  if (length == NT_I18N_FORMAT_OVERFLOW || length == NT_I18N_FORMAT_UNSUPPORTED) return length;
  if (length < 0 || (size_t)length > limit) return NT_I18N_FORMAT_OVERFLOW;
  state->length = length;
  return length;
}

// Returns staged byte index (0..255), or -1 when the index is outside the staged result.
static inline double nt_i18n_format_byte(void *userdata, double index) {
  nt_i18n_format_state *state = (nt_i18n_format_state *)userdata;
  if (state->length < 0 || !(index >= 0 && index < state->length) || index != (double)(int32_t)index) return -1;
  return state->bytes[(int32_t)index];
}
#ifdef __cplusplus
}
#endif
`;
  return [["messages.generated.ts", messages], ["contract.generated.ts", contract], ["contract.generated.mjs", hostContract], ["native/nt_i18n_format.generated.h", header]];
}

export function run({ specPath = join(here, "catalogue.json"), root = ROOT, outDir = here, check = false, sourceDirs = null, allowDynamic = [], log = console.log } = {}) {
  const spec = loadSpec(specPath);
  const catalogues = loadCatalogues(spec, root);
  const directories = sourceDirs ?? spec.sourceDirectories.map((directory) => resolve(root, directory));
  const files = directories.flatMap((directory) => listSourceFiles(directory));
  const scan = scanSources({
    root, files, i18nIndex: join(here, "index.ts"), catalogue: catalogues, keyProperties: spec.keyProperties,
    dynamicKeyFiles: [...spec.dynamicKeyFiles.map((file) => resolve(root, file)), ...allowDynamic.map((file) => resolve(file))],
  });
  if (scan.errors.length) throw new Error(scan.errors.join("\n"));
  let stale = 0;
  for (const [name, next] of renderOutputs(spec, catalogues)) {
    const path = join(outDir, name);
    let previous = ""; try { previous = readFileSync(path, "utf8"); } catch {}
    if (previous === next) continue;
    stale++;
    if (check) log(`stale: ${relative(root, path) || path}`);
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, next); }
  }
  const { report } = scan;
  log(`i18n: ${catalogues.locales.length} catalogues x ${catalogues.keys.size} keys; ${report.literalCalls} literal message calls (${report.verifiedArguments} argument lists verified) and ${report.keyProperties} key properties checked in ${files.length} files; ${scan.dynamic.length} declared runtime-checked dynamic sites${scan.dynamic.length ? ` (${scan.dynamic.join(", ")})` : ""}`);
  log(check ? (stale ? `i18n: ${stale} generated files stale` : "i18n: generated files up to date") : `i18n: wrote ${stale} files`);
  return { stale, scan, catalogues };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const values = (flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
  const known = new Set(["--check", "--source-dir", "--allow-dynamic", "--spec", "--out-dir", "--root"]);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) { console.error(`i18n: unknown argument ${args[i]}`); process.exit(2); }
    if (args[i] !== "--check") { if (args[i + 1] === undefined) { console.error(`i18n: ${args[i]} needs a value`); process.exit(2); } i++; }
  }
  const sourceDirs = values("--source-dir").map((directory) => resolve(directory));
  try {
    const spec = values("--spec")[0], out = values("--out-dir")[0], root = values("--root")[0];
    const result = run({
      check: args.includes("--check"), sourceDirs: sourceDirs.length ? sourceDirs : null, allowDynamic: values("--allow-dynamic"),
      ...(spec ? { specPath: resolve(spec) } : {}), ...(out ? { outDir: resolve(out) } : {}), ...(root ? { root: resolve(root) } : {}),
    });
    if (args.includes("--check") && result.stale) process.exit(1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
