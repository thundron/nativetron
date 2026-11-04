// Compiled evidence: builds i18n/fixture as a wasm32-wasi reactor and a native static library, then drives
// both through the scalar pull formatting contract. Requires scriptc (SCRIPTC), zig, and clang.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocaleFormatHost } from "./host.js";
import { LOCALES, MESSAGE_KEYS } from "./contract.generated.mjs";

const fixture = fileURLToPath(new URL("./fixture/", import.meta.url));
execFileSync(fileURLToPath(new URL("./fixture/build.sh", import.meta.url)), { stdio: ["ignore", "ignore", "inherit"], env: process.env });

const intlNumber = (locale, value, digits, unit = "") => new Intl.NumberFormat(locale, unit ? { maximumFractionDigits: digits, style: "unit", unit, unitDisplay: "short" } : { maximumFractionDigits: digits }).format(value);
const integers = Array.from({ length: 230 }, (_, i) => i);
const PLURAL_VALUES = [...integers, 1000, 1001, 1002, 1005, 1011, 1012, 1015, 1021, 1022, 1111, 1112, 999999, 1000000, 1000001, 2000000, 3000000, 10000000, 1e15, 5e-7, 0.0009995, 0.9995, 999.9995, 1.9995,
  -0, -1, -2, -5, -22, -1000000, 0.5, 1.5, 2.5, 0.1, 0.0045, 0.0005, 0.0625, 1.0004, 1.0005, 1.0006, 1.2345, 2.0001, 2.0004, 12.3, 21.5, 22.2, 1000000.5, 1e6 + 0.0004, 123456.789];
// Above the exact-integer range ICU's operands diverge from UTS #35 (it truncates i, e.g. fr 1e18 -> one and
// pl 999999999999999900 -> few). UTS #35 defines i as all integer digits; this module follows it, so these
// magnitudes are checked against the specification instead of Intl.
const SPECIFIED_LARGE = [[1e17, { en: "other", fr: "many", pl: "many" }], [999999999999999900, { en: "other", fr: "other", pl: "many" }], [1e18, { en: "other", fr: "many", pl: "many" }], [1e21, { en: "other", fr: "many", pl: "many" }], [1e300, { en: "other", fr: "many", pl: "many" }],
  [1234567e18, { en: "other", fr: "many", pl: "many" }], [2.2e21, { en: "other", fr: "many", pl: "many" }], [1.2345678901234567e21, { en: "other", fr: "other", pl: "many" }], [123456789012345670000, { en: "other", fr: "other", pl: "many" }]];
const sanitize = (value) => Object.is(value, -0) ? 0 : value;

function expectedPlural(locale, value) { return new Intl.PluralRules(locale).select(value); }

async function wasmFixture() {
  const { instantiateFromBytes } = await import(pathToFileURL(fixture + ".scriptc/fixture.mjs").href);
  const rendered = [], replies = [];
  const formatting = createLocaleFormatHost();
  const api = await instantiateFromBytes(readFileSync(fixture + ".scriptc/fixture.wasm"), {
    rendered: (text) => rendered.push(text), reply: (text) => replies.push(text), ...formatting.imports,
    panic: (text) => { throw new Error("fixture panic: " + text); },
  });
  const ask = (name, ...args) => { replies.length = 0; assert.equal(api[name](...args), 1); assert.equal(replies.length, 1); return replies[0]; };
  return { api, rendered, ask };
}

test("wasm reactor: only declared imports; reactive locale switching across three catalogues", async () => {
  const module = new WebAssembly.Module(readFileSync(fixture + ".scriptc/fixture.wasm"));
  const scriptcImports = WebAssembly.Module.imports(module).filter((entry) => entry.module !== "wasi_snapshot_preview1").map((entry) => `${entry.module}.${entry.name}`).sort();
  assert.deepEqual(scriptcImports, ["scriptc.localeFormatBegin", "scriptc.localeFormatByte", "scriptc.panic", "scriptc.rendered", "scriptc.reply"]);
  const { api, rendered, ask } = await wasmFixture();
  assert.equal(api.nt_i18n_start(), LOCALES.length);
  const view = (locale, title, items, greeting) => `${locale} | ${title} | ${items} | ${greeting} | ${intlNumber(locale, 1234.5, 1, "meter")}`;
  assert.deepEqual(rendered.splice(0), [view("en", "Commands", "1 item", "Hello, Ada")]);
  api.nt_i18n_set_count(5);
  assert.deepEqual(rendered.splice(0), [view("en", "Commands", "5 items", "Hello, Ada")]);
  assert.equal(ask("nt_i18n_switch_locale", "fr"), "ok fr");
  assert.deepEqual(rendered.splice(0), [view("fr", "Commandes", "5 éléments", "Bonjour, Ada")]);
  assert.equal(ask("nt_i18n_switch_locale", "fr"), "ok fr");
  assert.deepEqual(rendered.splice(0), [], "setting the active locale again does not re-render");
  api.nt_i18n_set_count(1000000);
  assert.deepEqual(rendered.splice(0), [view("fr", "Commandes", `${intlNumber("fr", 1000000, 3)} d’éléments`, "Bonjour, Ada")]);
  assert.equal(ask("nt_i18n_switch_locale", "pl"), "ok pl");
  assert.deepEqual(rendered.splice(0), [view("pl", "Polecenia", `${intlNumber("pl", 1000000, 3)} elementów`, "Witaj, Ada")]);
  api.nt_i18n_set_count(22);
  assert.deepEqual(rendered.splice(0), [view("pl", "Polecenia", "22 elementy", "Witaj, Ada")]);
  assert.equal(ask("nt_i18n_switch_locale", "de"), "error: unsupported locale: de");
  assert.deepEqual(rendered.splice(0), []);
  assert.equal(ask("nt_i18n_switch_locale", "en"), "ok en");
  assert.deepEqual(rendered.splice(0), [view("en", "Commands", "22 items", "Hello, Ada")]);
  assert.equal(api.nt_i18n_stop_rendering(), 1);
  api.nt_i18n_set_count(3);
  assert.equal(ask("nt_i18n_switch_locale", "fr"), "ok fr");
  assert.deepEqual(rendered.splice(0), [], "disposed effect no longer renders");
});

test("wasm reactor: compiled plural selection equals Intl.PluralRules; messages, arguments and formatting", async () => {
  const { api, ask } = await wasmFixture();
  api.nt_i18n_start();
  for (const locale of LOCALES) {
    assert.equal(ask("nt_i18n_switch_locale", locale), "ok " + locale);
    for (const value of PLURAL_VALUES) assert.equal(ask("nt_i18n_plural", value), expectedPlural(locale, value), `${locale} ${value}`);
    for (const [value, categories] of SPECIFIED_LARGE) assert.equal(ask("nt_i18n_plural", value), categories[locale], `${locale} ${value}`);
    for (const value of [12345.678, 0.5, -3.25, 1e9]) for (const digits of [0, 2, 3]) assert.equal(ask("nt_i18n_format", value, "", digits), intlNumber(locale, value, digits));
    for (const unit of ["millimeter", "meter", "kilometer", "inch", "foot", "liter"]) assert.equal(ask("nt_i18n_format", 1234.5, unit, 1), intlNumber(locale, 1234.5, 1, unit));
    for (const key of MESSAGE_KEYS.filter((key) => key.startsWith("commands."))) assert.notEqual(ask("nt_i18n_lookup", key), "absent");
  }
  assert.equal(ask("nt_i18n_switch_locale", "pl"), "ok pl");
  assert.equal(ask("nt_i18n_item_count", 0), "Brak elementów");
  assert.equal(ask("nt_i18n_item_count", 1), "1 element");
  assert.equal(ask("nt_i18n_item_count", 3), "3 elementy");
  assert.equal(ask("nt_i18n_item_count", 12), "12 elementów");
  assert.equal(ask("nt_i18n_item_count", 1.5), `${intlNumber("pl", 1.5, 3)} elementu`);
  assert.equal(ask("nt_i18n_switch_locale", "fr"), "ok fr");
  assert.equal(ask("nt_i18n_item_count", 0), "Aucun élément");
  assert.equal(ask("nt_i18n_item_count", 1.5), "1,5 élément");
  assert.equal(ask("nt_i18n_switch_locale", "en"), "ok en");
  assert.equal(ask("nt_i18n_item_count", 1.0004), "1 item", "plural operands follow the displayed value");
  assert.equal(ask("nt_i18n_item_count", -1), "-1 item");
  assert.equal(ask("nt_i18n_lookup", "commands.close"), "Close");
  assert.equal(ask("nt_i18n_lookup", "not.a.key"), "absent");
  assert.equal(ask("nt_i18n_wrong_argument"), "error: invalid numeric message argument: count");
  assert.equal(ask("nt_i18n_format", 1, "parsec", 1), "error: unsupported unit: parsec");
  assert.equal(ask("nt_i18n_format", 1, "meter", 21), "error: invalid number formatting options");
  assert.equal(ask("nt_i18n_format", Number.NaN, "", 1), "error: invalid number formatting options");
});

function native(commands) {
  const output = execFileSync(fixture + ".scriptc/harness", { input: commands.join("\n") + "\n", encoding: "utf8" });
  return output.trimEnd().split("\n");
}

test("native static library: reactive locale switching, pull adapter and explicit formatter failures", () => {
  const tag = (number, locale, unit = "") => [number, locale, unit].filter(Boolean).join("\u2009");
  const lines = native(["start", "count 5", "locale fr", "locale fr", "count 1000000", "locale pl", "count 22", "locale de", "items 1.5", "lookup commands.close", "lookup nope", "wrong",
    "format 12345.678 - 2", "format 666 - 2", "format 777 meter 1", "format 888 - 1", "format 1 parsec 1", "stop", "count 3", "locale en"]);
  const view = (locale, title, items, greeting) => `R ${locale} | ${title} | ${items} | ${greeting} | ${tag("1234.5", locale, "meter")}`;
  assert.deepEqual(lines, [
    view("en", "Commands", `${tag("1", "en")} item`, "Hello, Ada"), "A started 3",
    view("en", "Commands", `${tag("5", "en")} items`, "Hello, Ada"),
    view("fr", "Commandes", `${tag("5", "fr")} éléments`, "Bonjour, Ada"), "A ok fr", "A ok fr",
    view("fr", "Commandes", `${tag("1000000", "fr")} d’éléments`, "Bonjour, Ada"),
    view("pl", "Polecenia", `${tag("1000000", "pl")} elementów`, "Witaj, Ada"), "A ok pl",
    view("pl", "Polecenia", `${tag("22", "pl")} elementy`, "Witaj, Ada"),
    "A error: unsupported locale: de", `A ${tag("1.5", "pl")} elementu`, "A Zamknij", "A absent", "A error: invalid numeric message argument: count",
    `A ${tag("12345.68", "pl")}`, "A error: locale formatter returned invalid UTF-8", "A error: locale formatter does not support pl meter",
    "A error: locale formatter output overflow", "A error: unsupported unit: parsec", "A stopped 1", "A ok en",
  ]);
});

test("native static library: compiled plural selection equals Intl.PluralRules", () => {
  for (const locale of LOCALES) {
    const values = PLURAL_VALUES.map(sanitize);
    const large = SPECIFIED_LARGE.map(([value]) => value);
    const lines = native([`locale ${locale}`, ...[...values, ...large].map((value) => `plural ${value}`)]);
    assert.equal(lines[0], `A ok ${locale}`);
    assert.deepEqual(lines.slice(1), [...values.map((value) => `A ${expectedPlural(locale, value)}`), ...SPECIFIED_LARGE.map(([, categories]) => `A ${categories[locale]}`)], locale);
  }
});
