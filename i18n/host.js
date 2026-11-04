// Page-side formatting hooks for compiled i18n. All formatting is synchronous Intl.NumberFormat with
// standard notation, grouping, 0..maximumFractionDigits fraction digits and short unit display.
import { LOCALES, UNITS, MAX_FORMATTED_BYTES } from "./contract.generated.mjs";

export const FORMAT_OVERFLOW = -1;
export const FORMAT_UNSUPPORTED = -2;
const encoder = new TextEncoder();
const CACHE_LIMIT = 64;
const cache = new Map();

function formatText(value, locale, unit, maximumFractionDigits) {
  if (typeof value !== "number" || !Number.isFinite(value) || !LOCALES.includes(locale) || (unit !== "" && !UNITS.includes(unit))) return null;
  if (!Number.isInteger(maximumFractionDigits) || maximumFractionDigits < 0 || maximumFractionDigits > 20) return null;
  const key = `${locale}/${unit}/${maximumFractionDigits}`;
  let formatter = cache.get(key);
  if (!formatter) {
    const options = { maximumFractionDigits, notation: "standard" };
    if (unit) Object.assign(options, { style: "unit", unit, unitDisplay: "short" });
    formatter = new Intl.NumberFormat(locale, options);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, formatter);
  }
  return formatter.format(value);
}

// Direct-write callback for a page reactor profile callback [f64,string,string,f64,bytes] -> f64.
// It writes into the `output` view the glue passes for the guest's buffer. scriptc documents callback
// bytes as read-only borrows, so this relies on the current wasm32 lowering exposing the guest array's
// own storage; prefer createLocaleFormatHost() with pullLocaleFormatter for a documented contract.
export function formatLocaleNumber(value, locale, unit, maximumFractionDigits, output) {
  const text = formatText(value, locale, unit, maximumFractionDigits);
  if (text === null) return FORMAT_UNSUPPORTED;
  const result = encoder.encodeInto(text, output);
  if (result.read !== text.length) return FORMAT_OVERFLOW;
  return result.written;
}

// Scalar pull protocol for profile callbacks
//   localeFormatBegin [f64,string,string,f64,f64] -> f64 and localeFormatByte [f64] -> f64,
// bound in compiled code with pullLocaleFormatter(localeFormatBegin, localeFormatByte). The staged
// result lives in host-owned memory until the next begin; callbacks never call back into the module.
export function createLocaleFormatHost({ maxBytes = MAX_FORMATTED_BYTES } = {}) {
  const staging = new Uint8Array(maxBytes);
  let staged = -1;
  const begin = (value, locale, unit, maximumFractionDigits, capacity) => {
    staged = -1;
    const text = formatText(value, locale, unit, maximumFractionDigits);
    if (text === null || !Number.isInteger(capacity) || capacity < 0) return FORMAT_UNSUPPORTED;
    const target = staging.subarray(0, Math.min(capacity, staging.length));
    const result = encoder.encodeInto(text, target);
    if (result.read !== text.length) return FORMAT_OVERFLOW;
    staged = result.written;
    return staged;
  };
  const byteAt = (index) => Number.isInteger(index) && index >= 0 && index < staged ? staging[index] : -1;
  return { begin, byteAt, imports: { localeFormatBegin: begin, localeFormatByte: byteAt } };
}
