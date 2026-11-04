# Catalogues and formatting

`i18n/catalogue.json` (version 2) declares the supported locales, their catalogue files, CLDR cardinal plural rules, the plural fraction digits, the unit allowlist, the formatted-output bound, the source directories to analyse, key-bearing property names and the files allowed to use runtime keys. `locales/en.json` is the source catalogue; `locales/fr.json` and `locales/pl.json` translate every key, including the `commands.*` labels used by the palette.

`node i18n/generate.mjs` validates everything and writes the generated files; `--check` fails if any are stale. It emits:

- `messages.generated.ts`: compiled per-locale message functions, plural rules and `pluralCategory`. It has no runtime parser or eval.
- `contract.generated.ts` and `contract.generated.mjs`: locales, source locale, units, output bound, plural fraction digits, keys and (in `.mjs`) each locale's plural categories.
- `native/nt_i18n_format.generated.h`: the native pull-formatting adapter.

Generation fails when a catalogue is missing a key from the source catalogue or has extra keys, when a translation uses different argument names, when a branch names a category the locale's rule doesn't define, or when the spec names an undefined rule, an unsanctioned or compound unit, or an unknown field.

## Public compiled API

The command palette uses these names, so they keep their signatures:

- `locale.get()` is reactive. `setLocale(tag)` accepts only declared locales, throws `unsupported locale: <tag>` for anything else, and does nothing if the tag is already active.
- `message(key, args = [])` formats the message for the active locale and subscribes the caller to locale changes. Arguments are `textArgument(name, text)` or `numberArgument(name, value)`. A missing key, a missing or duplicate argument, more than 32 arguments, or a non-numeric or non-finite plural selector throws.
- `formatNumber(value, maximumFractionDigits = 3)` and `formatUnit(value, unit, maximumFractionDigits = 3)` call the installed formatter. The value must be finite, the digits an integer in 0..20, and the unit in the allowlist.
- `setLocaleFormatter((value, locale, unit, maximumFractionDigits, output) => length)` installs the synchronous formatter. `output` is a `Uint8Array` of `MAX_FORMATTED_BYTES` (512 bytes).

These are new and change nothing that already exists: `supportedLocales()`, `hasMessage(key)`, `pluralCategoryOf(value)`, `pullLocaleFormatter(begin, byteAt)`, the `LocaleFormatter` type, and `FORMAT_OVERFLOW` (-1) / `FORMAT_UNSUPPORTED` (-2).

Formatter contract: the formatter is called synchronously with a declared locale, `""` or an allowlisted unit, and validated digits. It writes UTF-8 to `output[0..length)` and returns `length`, or returns one of the two negative codes, which become `locale formatter output overflow` / `locale formatter does not support …` errors. The guest rejects any other result, including malformed UTF-8 (`locale formatter returned invalid UTF-8`). Output is never truncated. A formatter that reenters formatting, or a call to `setLocaleFormatter` while formatting is in progress, throws. Calling formatting with no formatter installed throws `locale formatter is not installed`.

## Integration hooks

All hooks are synchronous, use no promises, timers or outbound FFI, and add no runtime dependencies. They are valid in scriptc library mode.

- **Pull protocol (recommended for Wasm and native libraries).** scriptc documents callback `bytes`/`string` parameters as read-only borrows and callback results as scalars only. Declare two profile callbacks, `localeFormatBegin` with params `[f64,string,string,f64,f64]` returning `f64`, and `localeFormatByte` with params `[f64]` returning `f64`. Then install `setLocaleFormatter(pullLocaleFormatter(localeFormatBegin, localeFormatByte))`. `begin(value, locale, unit, digits, capacity)` formats into host-owned staging and returns its length or a negative code; `byteAt(i)` returns staged bytes. Each format costs one callback plus one per output byte, bounded by 512.
  - Page: `createLocaleFormatHost().imports` from `i18n/host.js` supplies both callbacks using real `Intl.NumberFormat`: standard notation, grouping, short unit display, and a bounded 64-entry formatter cache. The host refuses undeclared locales and units.
  - Native/static library: `#include "i18n/native/nt_i18n_format.generated.h"`, then initialise an `nt_i18n_format_state` with a platform formatter `int32_t (*)(void *ctx, double value, const char *locale, const char *unit, int32_t digits, uint8_t *out, size_t capacity)`. Register `nt_i18n_format_begin` / `nt_i18n_format_byte` with that state as userdata through the profile's `callback_register_symbol`. The adapter copies the borrowed strings and validates the locale, unit, digits and capacity. It never calls into the library. This module has no native ICU binding: platform owners supply the formatter (for example NSNumberFormatter/NSMeasurementFormatter or android.icu.number), and it must follow the same notation, grouping and unit-display rules.
- **Direct write (existing in-page path).** `formatLocaleNumber` from `i18n/host.js` binds to a profile callback with params `[f64,string,string,f64,bytes]` returning `f64` and writes with `TextEncoder.encodeInto` into the view the glue passes. This works because the current scriptc wasm32 lowering passes the guest array's own storage, which scriptc's callback contract (read-only borrows) does not promise. `framework/components.fixture.ts` still uses this path, so it is kept; new embeddings should use the pull protocol. It returns `FORMAT_UNSUPPORTED` for undeclared locales or units and `FORMAT_OVERFLOW` instead of truncating.

## Supported message and plural semantics

Messages are an ICU MessageFormat subset: text, `{name}` arguments, and `{name, plural, …}` cardinal plurals with `=N` exact branches, the locale's CLDR categories, a required `other`, nesting, and `#` (the innermost plural's number, formatted like `formatNumber`). Generation rejects everything else instead of approximating it: `select`, `selectordinal`, `number`, `date`/`time` and other argument types, plural `offset:`, and apostrophe quoting (`'{'`, `''`). An apostrophe that doesn't precede `{`, `}`, `#`, `|` or `'` is ordinary text.

Plural rules use CLDR rule syntax (UTS #35). The supported subset is the operands `n i v w f t e c`, `%`, `=`/`!=` against values and integer ranges `a..b`, `and` and `or`. Samples (`@integer`), `is`/`in`/`within`/`not`, and decimal literals are rejected. Exact branches compare the raw argument value, as ICU does.

Category selection uses the number as it is displayed:

1. Take the shortest round-trip decimal of the double, as ICU does.
2. Round half away from zero to `pluralFractionDigits` (3, matching `formatNumber`'s default and Intl's default).
3. Drop trailing zeros, so `w = v` and `t = f`.
4. Standard notation is never compact, so `e = c = 0`.

So `1.0004` selects `one` in English ("1 item"), and integer-only ranges never match a visible fraction. `i % m` and `n % m` are computed exactly from the decimal digits. Below 1e15, both compiled lanes are checked against `Intl.PluralRules` for en/fr/pl. Above that, ICU truncates the integer operand (for example, it puts French 1e18 in `one` and Polish 999999999999999900 in `few`). This module follows UTS #35 instead, and tests check those values against the specification.

Supported locales are the three declared ones, en, fr and pl, with rules copied from CLDR. Adding a locale means declaring its CLDR rule text and catalogue. Generation validates the rule syntax but cannot verify it against CLDR; `i18n.test.mjs` compares the declared rules with Intl's categories and selections.

## Static missing-key analysis boundary

`generate.mjs` lexes `.ts/.tsx/.js/.jsx/.mjs/.cjs` sources, handling comments, strings, template substitutions, regular-expression literals and JSX. A file that cannot be lexed fails explicitly. In files that import the i18n module through a relative specifier, the analysis proves:

- Every `message("literal", …)` call names a key that exists in every catalogue. This covers named imports, aliases and `namespace.message`, and no-substitution template literals.
- When the arguments are a literal array of imported `textArgument("name", …)`/`numberArgument("name", …)` calls, the names match the message exactly, and plural selectors use `numberArgument`.
- Literal values of declared key-bearing properties (`labelKey: "…"`) in any scanned file name existing keys.

It does not prove keys computed at runtime. Non-literal keys, using `message` as a value, and re-exporting it or the namespace all fail generation unless the file is listed in `dynamicKeyFiles`. Currently only `commands/index.ts` is listed, and its three sites are reported on every run. Those sites, and argument lists that aren't literal arrays, rely on runtime errors.

The analysis is lexical, not type-directed. A local binding that shadows the imported name is still treated as the i18n function, which can only cause a conservative failure. Files that don't import i18n are only checked for key properties. `--source-dir DIR` (repeatable) analyses an application tree instead of `sourceDirectories`, and `--allow-dynamic FILE` declares extra runtime-key files.

## Checks

- `node i18n/generate.mjs --check`
- `node --test i18n/i18n.test.mjs`: the parser, rule syntax, rules against Intl, isolated test catalogues, validation failures, static analysis, the lexer and the host hooks.
- `SCRIPTC=… node --test --test-concurrency=1 i18n/compiled.test.mjs`: builds `i18n/fixture` with `i18n/fixture/build.sh` as both a wasm32-wasi reactor (needs zig) and a host static library with a C harness (needs clang). It checks, on real compiled code:
  - reactive locale switching across en/fr/pl and disposal;
  - that the wasm module imports only its declared callbacks;
  - plural selection against `Intl.PluralRules`;
  - Intl-formatted numbers and units through the pull protocol;
  - argument errors, and the native adapter's overflow, unsupported and invalid-UTF-8 failures.
- `node framework/components.test.mjs`: the existing browser integration, through the direct-write path.
