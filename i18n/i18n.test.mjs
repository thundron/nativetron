import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMessage, messageArguments } from "./message-parser.mjs";
import { compilePluralRule, parsePluralCondition, pluralRuleEvaluator } from "./plural-rules.mjs";
import { lex } from "./source-scan.mjs";
import { run, loadSpec, ROOT } from "./generate.mjs";
import { formatLocaleNumber, createLocaleFormatHost, FORMAT_OVERFLOW, FORMAT_UNSUPPORTED } from "./host.js";
import { LOCALES, MESSAGE_KEYS, PLURAL_CATEGORIES } from "./contract.generated.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const generator = join(here, "generate.mjs");
const quiet = () => {};
const temp = () => mkdtempSync(join(tmpdir(), "nt-i18n-"));

// Test-side mirror of i18n/plural.ts (the compiled implementation is compared with Intl in compiled.test.mjs).
function operands(value, fractionDigits = 3) {
  const text = String(Math.abs(value));
  let [mantissa, exponent = "0"] = text.split("e");
  const dot = mantissa.indexOf(".");
  let digits = mantissa.replace(".", "");
  let point = (dot < 0 ? mantissa.length : dot) + Number(exponent);
  if (point <= 0) { digits = "0".repeat(1 - point) + digits; point = 1; }
  digits = digits.padEnd(point, "0");
  if (digits.length > point + fractionDigits) {
    const up = digits[point + fractionDigits] >= "5";
    digits = digits.slice(0, point + fractionDigits);
    if (up) { const next = (BigInt(digits) + 1n).toString().padStart(digits.length, "0"); if (next.length > digits.length) point++; digits = next; }
  }
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, ""), fraction = digits.slice(point).replace(/0+$/, "");
  return { i: Number(integer), v: fraction.length, f: fraction ? Number(fraction) : 0, iDigits: integer, fDigits: fraction || "0" };
}

test("shipped catalogues: three locales, identical keys, command labels translated", () => {
  assert.deepEqual(LOCALES, ["en", "fr", "pl"]);
  const catalogues = Object.fromEntries(LOCALES.map((tag) => [tag, JSON.parse(readFileSync(join(ROOT, "locales", tag + ".json"), "utf8"))]));
  for (const key of ["commands.title", "commands.search", "commands.empty", "commands.close"]) {
    assert.ok(MESSAGE_KEYS.includes(key));
    assert.equal(new Set(LOCALES.map((tag) => catalogues[tag][key])).size, LOCALES.length, `${key} is translated`);
  }
  for (const tag of LOCALES) assert.deepEqual(Object.keys(catalogues[tag]).sort(), MESSAGE_KEYS);
  assert.deepEqual(PLURAL_CATEGORIES, { en: ["one", "other"], fr: ["one", "many", "other"], pl: ["one", "few", "many", "other"] });
});

test("generated outputs are current and --check fails when stale", () => {
  execFileSync(process.execPath, [generator, "--check"], { stdio: "pipe" });
  const out = temp();
  try {
    const first = run({ outDir: out, log: quiet });
    assert.equal(first.stale, 4);
    assert.equal(run({ outDir: out, check: true, log: quiet }).stale, 0);
    writeFileSync(join(out, "messages.generated.ts"), "// edited\n");
    const lines = [];
    assert.equal(run({ outDir: out, check: true, log: (line) => lines.push(line) }).stale, 1);
    assert.match(lines.join("\n"), /stale: .*messages\.generated\.ts/);
    assert.throws(() => execFileSync(process.execPath, [generator, "--check", "--bogus"], { stdio: "pipe" }), /unknown argument/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("ICU subset: arguments, nested cardinal plurals, exact branches and # substitution", () => {
  const ast = parseMessage("{n, plural, =0 {none} one {# item} other {{name}: # items {m, plural, other {# sub}}}}", ["one", "other"]);
  assert.equal(ast[0].kind, "plural");
  assert.deepEqual(ast[0].cases.map((entry) => entry.key), ["=0", "one", "other"]);
  assert.deepEqual([...messageArguments(ast)], [["n", "number"], ["name", "any"], ["m", "number"]]);
  assert.deepEqual(parseMessage("a # b {x} it's"), [{ kind: "text", value: "a # b " }, { kind: "argument", name: "x" }, { kind: "text", value: " it's" }]);
  assert.equal(parseMessage("{n, plural, few {f} many {m} other {o}}", ["one", "few", "many", "other"])[0].cases.length, 3);
});

test("ICU subset: unsupported syntax fails explicitly instead of being approximated", () => {
  const rejects = {
    "{n, plural, one {one}}": /requires an other branch/,
    "{n, select, a {x} other {y}}": /unsupported ICU argument type "select"/,
    "{n, selectordinal, one {first} other {rest}}": /unsupported ICU argument type "selectordinal"/,
    "{n, number}": /unsupported ICU argument type "number"/,
    "{n, date, short}": /unsupported ICU argument type "date"/,
    "{n, plural, offset:1 one {one} other {other}}": /offset is not supported/,
    "{n, plural, one {one} one {again} other {other}}": /duplicate plural branch one/,
    "{n, plural, =1 {a} =1.0 {b} other {c}}": /duplicate plural branch =1.0/,
    "{n, plural, few {f} other {o}}": /category few is not defined by this locale's rule/,
    "{n, plural, zero {z} other {o}}": /category zero is not defined/,
    "{unterminated": /expected , or }/,
    "{n, plural, one {x} other {y}": /unterminated ICU plural/,
    "stray }": /unmatched ICU close brace/,
    "'{escaped}'": /apostrophe quoting is not supported/,
    "it''s": /apostrophe quoting is not supported/,
    "{1}": /expected ICU argument name/,
  };
  for (const [source, error] of Object.entries(rejects)) assert.throws(() => parseMessage(source), error, source);
});

test("plural rule syntax: supported CLDR subset and explicit refusals", () => {
  assert.deepEqual(parsePluralCondition("i = 1 and v = 0"), [[{ operand: "i", modulo: null, negated: false, ranges: [[1, 1]] }, { operand: "v", modulo: null, negated: false, ranges: [[0, 0]] }]]);
  for (const [source, error] of [["n = 1 @integer 1", /samples are not supported/], ["n is 1", /unsupported plural relation "is"/], ["n in 1..2", /unsupported plural relation "in"/],
    ["n within 1..2", /unsupported plural relation/], ["n = 1.5", /unsupported plural rule syntax/], ["x = 1", /unsupported plural operand/], ["n = 3..1", /empty plural range/],
    ["n % 0 = 1", /modulo must be/], ["n = 1 and", /truncated/], ["", /non-empty/]]) assert.throws(() => parsePluralCondition(source), error, source);
  assert.throws(() => compilePluralRule("bad", { other: "n = 1" }), /other is implicit/);
  assert.throws(() => compilePluralRule("bad", { lots: "n = 1" }), /unknown category/);
  // n ranges are integer-domain; v = 0 guards fractional n.
  const rule = pluralRuleEvaluator(compilePluralRule("test", { few: "n = 2..4", many: "n % 10 = 7 or e != 0" }));
  assert.deepEqual([2, 3, 3.5, 4, 5, 17, 17.5].map((value) => rule(operands(value))), ["few", "few", "other", "few", "other", "many", "other"]);
});

test("declared plural rules with display-value operands match Intl.PluralRules below 1e15", () => {
  const spec = loadSpec(join(here, "catalogue.json"));
  const values = [...Array.from({ length: 1200 }, (_, i) => i), 1e6, 2e6, 1000001, 1e9, 123456789, 0.5, 1.5, 0.0045, 0.0005, 1.0004, 1.0005, 1.9995, 0.9995, 21.5, 22.25, 5e-7, 1e14, -1, -2, -22];
  for (let i = 0; i < 2000; i++) values.push(Math.round(Math.random() * 1e7) / [1, 10, 100, 1000, 10000][i % 5]);
  for (const locale of spec.locales) {
    const evaluate = pluralRuleEvaluator(spec.rules.get(locale.pluralRule));
    const intl = new Intl.PluralRules(locale.tag);
    assert.deepEqual(intl.resolvedOptions().pluralCategories.sort(), [...spec.rules.get(locale.pluralRule).categories].sort(), locale.tag);
    for (const value of values) assert.equal(evaluate(operands(value)), intl.select(value), `${locale.tag} ${value}`);
  }
});

function fixtureSpec(directory, overrides = {}, catalogues = {}) {
  const spec = {
    version: 2, sourceLocale: "en",
    locales: [{ tag: "en", catalogue: "en.json", pluralRule: "en" }, { tag: "pl", catalogue: "pl.json", pluralRule: "pl" }],
    pluralRules: { en: { one: "i = 1 and v = 0" }, pl: { one: "i = 1 and v = 0", few: "v = 0 and i % 10 = 2..4 and i % 100 != 12..14", many: "v = 0 and i != 1 and i % 10 = 0..1 or v = 0 and i % 10 = 5..9 or v = 0 and i % 100 = 12..14" } },
    pluralFractionDigits: 3, units: ["meter"], maxFormattedBytes: 64, sourceDirectories: ["src"], keyProperties: ["labelKey"], dynamicKeyFiles: [], ...overrides,
  };
  const files = {
    "en.json": { "app.title": "Planner", "rooms": "{count, plural, one {# room} other {# rooms}}", "hello": "Hi {name}" },
    "pl.json": { "app.title": "Planista", "rooms": "{count, plural, one {# pokój} few {# pokoje} many {# pokoi} other {# pokoju}}", "hello": "Cześć {name}" },
    ...catalogues,
  };
  mkdirSync(join(directory, "src"), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), JSON.stringify(content));
  writeFileSync(join(directory, "catalogue.json"), JSON.stringify(spec));
  return join(directory, "catalogue.json");
}

test("isolated test catalogues: generation succeeds and emits per-locale rules", () => {
  const directory = temp();
  try {
    const specPath = fixtureSpec(directory);
    run({ specPath, root: directory, outDir: join(directory, "out"), log: quiet });
    const generated = readFileSync(join(directory, "out", "messages.generated.ts"), "utf8");
    assert.match(generated, /function rule_pl\(o: PluralOperands\)/);
    assert.match(generated, /if \(category1 === "few"\) return "" \+ numericFormat\(count1\) \+ " pokoje";/);
    assert.match(readFileSync(join(directory, "out", "contract.generated.ts"), "utf8"), /LOCALES = \["en","pl"\]/);
    assert.match(readFileSync(join(directory, "out", "native", "nt_i18n_format.generated.h"), "utf8"), /#define NT_I18N_MAX_FORMATTED_BYTES 64/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("catalogue validation: missing/extra translations, argument drift and invalid specs fail", () => {
  const cases = [
    [{}, { "pl.json": { "app.title": "Planista", "hello": "Cześć {name}" } }, /pl.json: missing translation for rooms/],
    [{}, { "pl.json": { "app.title": "Planista", "rooms": "{count, plural, other {#}}", "hello": "Cześć {name}", "extra": "x" } }, /extra is not in the source catalogue/],
    [{}, { "pl.json": { "app.title": "Planista", "rooms": "{count, plural, other {#}}", "hello": "Cześć {imie}" } }, /hello uses arguments \{imie\} but en.json uses \{name\}/],
    [{}, { "en.json": { "app.title": "x", "rooms": "{count, plural, few {#} other {#}}", "hello": "{name}" } }, /en.json: rooms: plural category few is not defined/],
    [{ version: 1 }, {}, /version must be 2/],
    [{ units: ["parsec"] }, {}, /not a sanctioned single unit/],
    [{ units: ["meter-per-second"] }, {}, /not a sanctioned single unit/],
    [{ sourceLocale: "de" }, {}, /sourceLocale must be one of locales/],
    [{ locales: [{ tag: "en", catalogue: "en.json", pluralRule: "missing" }] }, {}, /undefined plural rule/],
    [{ locales: [{ tag: "EN", catalogue: "en.json", pluralRule: "en" }] }, {}, /unsupported locale tag/],
    [{ pluralFractionDigits: 16 }, {}, /pluralFractionDigits/],
    [{ pluralRules: { en: { one: "n = 1 @integer 1" }, pl: { one: "i = 1" } } }, {}, /samples are not supported/],
    [{ extra: true }, {}, /unknown field extra/],
  ];
  for (const [overrides, catalogues, error] of cases) {
    const directory = temp();
    try {
      const specPath = fixtureSpec(directory, overrides, catalogues);
      assert.throws(() => run({ specPath, root: directory, outDir: join(directory, "out"), log: quiet }), error);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

const specifierFrom = (file) => { const path = relative(dirname(file), join(here, "index.js")); return JSON.stringify(path.startsWith(".") ? path : "./" + path); };

test("static key analysis: literal calls, aliases, namespaces, arguments and key properties", () => {
  const directory = temp();
  const write = (name, source) => {
    const path = join(directory, "src", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source.replaceAll("I18N", specifierFrom(path)));
  };
  const check = (sources, allowDynamic = []) => {
    rmSync(join(directory, "src"), { recursive: true, force: true });
    const specPath = fixtureSpec(directory);
    for (const [name, source] of Object.entries(sources)) write(name, source);
    return run({ specPath, root: directory, outDir: join(directory, "out"), log: quiet, allowDynamic: allowDynamic.map((name) => join(directory, "src", name)) }).scan;
  };
  try {
    const ok = check({
      "a.ts": 'import { message, numberArgument as n, textArgument } from I18N;\n// message("commented.out")\nconst s = "message(\\"in.a.string\\")";\nerror.message("not.i18n");\nmessage("app.title");\nmessage(`app.title`);\nmessage("rooms", [n("count", 3)]);\nmessage("hello", [textArgument("name", user.name)]);\nmessage("hello", args);\nconst re = /message\\("x"\\)/;\n',
      "b.ts": 'import { message as t } from I18N;\nexport const x = { message: 1, label: t("app.title") };\n',
      "c.ts": 'import * as i18n from I18N;\ni18n.message("rooms", [i18n.numberArgument("count", 1)]);\nregister({ id: "a", labelKey: "app.title" });\n',
      "d.tsx": 'import { message } from I18N;\nconst view = <p title={message("app.title")}>Don\'t {message("hello", [textArgument("name", "x")])} <b>{`${message("app.title")}`}</b></p>;\n',
      "e.ts": 'const message = (key: string) => key;\nmessage("not.checked.without.import");\n',
    });
    assert.equal(ok.errors.length, 0);
    assert.equal(ok.report.literalCalls, 10);
    assert.equal(ok.report.verifiedArguments, 8, "d.tsx uses an unimported textArgument, so its list stays runtime-checked");
    assert.equal(ok.report.keyProperties, 1);
    const errors = (sources, allowDynamic) => { try { check(sources, allowDynamic); return []; } catch (error) { return error.message.split("\n"); } };
    assert.deepEqual(errors({ "a.ts": 'import { message } from I18N;\nmessage("missing.key");\n' }), ["src/a.ts:2: missing message key missing.key (literal message call)"]);
    assert.deepEqual(errors({ "a.ts": 'import { message as t } from I18N;\nt("missing.alias");\n' }), ["src/a.ts:2: missing message key missing.alias (literal message call)"]);
    assert.deepEqual(errors({ "a.ts": 'import * as i18n from I18N;\ni18n.message("missing.ns");\n' }), ["src/a.ts:2: missing message key missing.ns (literal message call)"]);
    assert.deepEqual(errors({ "a.ts": 'register({ labelKey: "missing.label" });\n' }), ["src/a.ts:1: missing message key missing.label (labelKey property)"]);
    assert.deepEqual(errors({ "a.tsx": 'import { message } from I18N;\nconst v = <p>{message("missing.jsx")}</p>;\n' }), ["src/a.tsx:2: missing message key missing.jsx (literal message call)"]);
    assert.deepEqual(errors({ "a.ts": 'import { message, textArgument, numberArgument } from I18N;\nmessage("rooms", [textArgument("count", "3")]);\nmessage("hello", []);\nmessage("hello", [textArgument("name", "a"), textArgument("extra", "b")]);\n' }), [
      "src/a.ts:2: message rooms argument count selects a plural and needs numberArgument", "src/a.ts:3: message hello is missing argument name", "src/a.ts:4: message hello has no argument extra"]);
    assert.deepEqual(errors({ "a.ts": 'import { message } from I18N;\nmessage(key);\nmessage("app." + part);\n' }), [
      "src/a.ts:2: message key is not a string literal; declare the file in dynamicKeyFiles to rely on the runtime check",
      "src/a.ts:3: message key is not a string literal; declare the file in dynamicKeyFiles to rely on the runtime check"]);
    assert.deepEqual(check({ "a.ts": 'import { message } from I18N;\nmessage(command.labelKey);\n' }, ["a.ts"]).dynamic, ["src/a.ts:2"]);
    assert.deepEqual(errors({ "a.ts": 'import { message } from I18N;\nconst t = message;\n' }), ["src/a.ts:2: uses message other than as a direct call; not statically analysable"]);
    assert.deepEqual(errors({ "a.ts": 'export { message } from I18N;\n' }), ["src/a.ts:1: re-exports message; uses through the re-export cannot be analysed; not statically analysable"]);
    assert.deepEqual(errors({ "a.ts": 'import * as i18n from I18N;\nuse(i18n);\n' }), ["src/a.ts:2: uses i18n namespace i18n as a value; not statically analysable"]);
    assert.match(errors({ "a.ts": 'import { message } from I18N;\nmessage("app.title");\nconst s = "unterminated;\n' })[0], /cannot lex an unterminated string literal/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("static key analysis: --source-dir checks an application tree", () => {
  const directory = temp();
  try {
    writeFileSync(join(directory, "app.ts"), `import { message } from ${specifierFrom(join(directory, "app.ts"))};\nmessage("not.in.catalogue");\n`);
    assert.throws(() => execFileSync(process.execPath, [generator, "--check", "--source-dir", directory], { stdio: "pipe" }), /missing message key not.in.catalogue/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("lexer: templates, regular expressions, comments and JSX", () => {
  const tokens = lex("const a = `x${b + `y${c}`}z`; const r = /[/]x/g; /* message */ f(a / 2);", "t.ts");
  assert.deepEqual(tokens.filter((token) => token.type === "regex").map((token) => token.value), ["/[/]x/g"]);
  assert.ok(tokens.some((token) => token.type === "id" && token.value === "c"));
  const jsx = lex('const v = <A b="c" d={e}>text\'s {f(<g />)}</A>;', "t.tsx");
  assert.deepEqual(jsx.filter((token) => token.type === "id").map((token) => token.value), ["const", "v", "e", "f"]);
  assert.throws(() => lex("a = `open", "t.ts"), /unterminated template literal/);
});

test("page formatting hooks: Intl output, bounded writes and pull protocol", () => {
  const output = new Uint8Array(512);
  const count = formatLocaleNumber(12345.678, "en", "meter", 2, output);
  assert.equal(new TextDecoder().decode(output.subarray(0, count)), "12,345.68 m");
  assert.equal(formatLocaleNumber(12345, "en", "", 2, new Uint8Array(1)), FORMAT_OVERFLOW);
  assert.equal(formatLocaleNumber(1, "de", "", 2, output), FORMAT_UNSUPPORTED);
  assert.equal(formatLocaleNumber(1, "en", "parsec", 2, output), FORMAT_UNSUPPORTED);
  assert.equal(formatLocaleNumber(Number.NaN, "en", "", 2, output), FORMAT_UNSUPPORTED);
  const host = createLocaleFormatHost();
  const expected = new TextEncoder().encode(new Intl.NumberFormat("fr", { maximumFractionDigits: 1, style: "unit", unit: "kilometer", unitDisplay: "short" }).format(1234.56));
  assert.equal(host.begin(1234.56, "fr", "kilometer", 1, 512), expected.length);
  assert.deepEqual(Uint8Array.from({ length: expected.length }, (_, i) => host.byteAt(i)), expected);
  assert.equal(host.byteAt(expected.length), -1);
  assert.equal(host.begin(1234.56, "fr", "kilometer", 1, 3), FORMAT_OVERFLOW);
  assert.equal(host.byteAt(0), -1, "a failed begin discards the staged result");
  assert.equal(host.begin(1, "pl", "", 21, 512), FORMAT_UNSUPPORTED);
  assert.deepEqual(Object.keys(host.imports), ["localeFormatBegin", "localeFormatByte"]);
});
