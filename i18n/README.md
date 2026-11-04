# Catalogues and formatting

`locales/en.json` contains the first catalogue. `i18n/catalogue.json` describes supported locales, plural rules, units, output bounds and source directories. `node i18n/generate.mjs --check` validates the catalogue, checks literal `message("key")` calls in those directories, and checks generated compiled functions. `--source-dir /path/to/app` checks an application's literal uses instead. Dynamic keys cannot be proven by that scan and fail explicitly at runtime when missing.

Public compiled API:

- `locale.get()` is reactive; `setLocale(tag)` validates supported catalogues before updating it.
- `message(key, args = [])` formats a generated message. Arguments are `textArgument(name, text)` or `numberArgument(name, value)`. Missing/duplicate arguments and invalid numeric values throw.
- `formatNumber(value, maximumFractionDigits = 3)` and `formatUnit(value, unit, maximumFractionDigits = 3)` use the installed platform formatter.
- `setLocaleFormatter((value, locale, unit, maximumFractionDigits, outputBytes) => length)` installs a synchronous bounded byte-output callback. No host reentry or asynchronous result is required.

For in-page reactors, bind a profile callback with parameters `[f64,string,string,f64,bytes]`, return `f64`, and supply `formatLocaleNumber` from `i18n/host.js`. It uses real `Intl.NumberFormat`, a bounded formatter cache and `TextEncoder.encodeInto` into borrowed linear memory. Overflow fails rather than truncating. A native/static-library embedding must supply an equivalent formatter callback; there is no automatic native ICU binding in this module. Calling formatting without installation throws.

The supported ICU-style subset is named arguments and nested cardinal plurals with exact-number, `one`, and required `other` branches; `#` substitutes the active plural number. Only English cardinal rules/catalogues are currently accepted. Select/ordinal forms, plural offsets, apostrophe escapes and other locale rules are rejected at generation time, not approximated. Apostrophes not used as ICU escapes remain ordinary text. Number and sanctioned-unit formatting follow the host's Intl data; the generated unit allowlist is explicit.

Checks: `node --test i18n/i18n.test.mjs`; the real compiled browser integration is `node framework/components.test.mjs`.
